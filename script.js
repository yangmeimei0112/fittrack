// --------------------------------------------------------
// FitTrack 最終版邏輯 (v25.2 - 修復版)
// --------------------------------------------------------

const SUPABASE_URL = 'https://szhdnodigzybxwnftdgm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6aGRub2RpZ3p5Ynh3bmZ0ZGdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3NzM0NjYsImV4cCI6MjA4MDM0OTQ2Nn0.5evNyYmufJ9KaWYw4QsD4btgrQDMkIiYNbUhEaf52NE';

// [新增] FHIR Server 設定
const FHIR_SERVER_URL = 'https://hapi.fhir.org/baseR4';

// 初始化 Supabase
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// 全域變數
let myChart = null;       
let classChart = null;    
let html5QrcodeScanner = null;
let currentUserRole = 'student'; 
let currentUserId = null;
let currentUserStudentId = null;
let systemSettings = { 
    maintenance_mode: { login: false, student: false, teacher: false, quick: false },
    marquee_settings: { text: "", enabled: false }
};
let autoRefreshInterval = null;

// ================= 1. FHIR 整合邏輯 (核心新增) =================

// 1. 上傳/同步病人資料 (Patient)
async function syncPatientToFHIR(studentData) {
    console.log("正在同步病人資料到 FHIR...");
    
    // 檢查該學號是否已經存在於 FHIR Server
    const searchUrl = `${FHIR_SERVER_URL}/Patient?identifier=${studentData.student_id}`;
    
    try {
        const resp = await fetch(searchUrl);
        const data = await resp.json();
        
        if (data.entry && data.entry.length > 0) {
            console.log("FHIR: 病人已存在，ID:", data.entry[0].resource.id);
            return data.entry[0].resource.id; // 回傳現有的 FHIR ID
        } else {
            // 若不存在，建立新病人
            const newPatient = {
                resourceType: "Patient",
                identifier: [{ 
                    system: "https://github.com/yangmeimei0112/fittrack", 
                    value: studentData.student_id 
                }],
                name: [{ text: studentData.name }],
                gender: studentData.gender === 'male' ? 'male' : 'female',
                active: true
            };

            const createResp = await fetch(`${FHIR_SERVER_URL}/Patient`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newPatient)
            });
            const createData = await createResp.json();
            console.log("FHIR: 新病人建立成功，ID:", createData.id);
            return createData.id;
        }
    } catch (err) {
        console.error("FHIR Sync Error:", err);
        return null;
    }
}

// 2. 上傳生理量測資料 (Observation)
async function syncObservationToFHIR(dbStudentId, code, value, unit, date) {
    console.log("正在上傳數據到 FHIR...", code, value);

    // 步驟 A: 先從 Supabase 取得學生詳細資料 (為了拿到學號)
    const { data: student } = await supabaseClient.from('students').select('*').eq('id', dbStudentId).single();
    if (!student) return;

    // 步驟 B: 取得或建立 FHIR Patient ID
    const fhirPatientId = await syncPatientToFHIR(student);
    if (!fhirPatientId) return;

    // 步驟 C: 對應 LOINC 代碼 (國際標準)
    let loincCode = "unknown";
    let display = "unknown";
    
    if (code === 'height') { loincCode = '8302-2'; display = 'Body height'; }
    else if (code === 'weight') { loincCode = '29463-7'; display = 'Body weight'; }
    else if (code === 'heartrate') { loincCode = '8867-4'; display = 'Heart rate'; }
    else if (code === 'run800') { loincCode = 'X-RUN800'; display = '800m Run'; } // 自定義代碼

    // 步驟 D: 建立 Observation 資源
    const observation = {
        resourceType: "Observation",
        status: "final",
        code: {
            coding: [{ system: "http://loinc.org", code: loincCode, display: display }]
        },
        subject: { reference: `Patient/${fhirPatientId}` },
        valueQuantity: {
            value: Number(value),
            unit: unit,
            system: "http://unitsofmeasure.org"
        },
        effectiveDateTime: date
    };

    // 步驟 E: 發送請求
    try {
        await fetch(`${FHIR_SERVER_URL}/Observation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(observation)
        });
        console.log("FHIR: 數據上傳成功！");
    } catch (err) {
        console.error("FHIR Observation Error:", err);
    }
}

// ================= 2. 靜態資料與輔助 =================

const taiwanCities = ["臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市", "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];
const partnerSchools = { "臺北市": ["臺北市萬芳高級中學"] };
let selectedSchoolName = "";

const bmiStandards = {
    male: { 13: [16.2, 21.9, 24.2], 14: [16.6, 22.5, 24.9], 15: [17.0, 22.9, 25.4], 16: [17.4, 23.4, 25.8], 17: [17.9, 23.9, 26.3], 18: [18.5, 24.0, 27.0] },
    female: { 13: [16.2, 21.6, 23.9], 14: [16.6, 22.0, 24.4], 15: [16.9, 22.3, 24.7], 16: [17.1, 22.5, 24.9], 17: [17.3, 22.7, 25.1], 18: [18.5, 24.0, 27.0] }
};

function getBMIStatus(bmi, age, gender) {
    if (!age || !gender || !bmi) return { status: "未知", color: "secondary" };
    const lookupAge = (age > 18) ? 18 : (age < 13 ? 13 : age);
    const standard = bmiStandards[gender === 'male' ? 'male' : 'female'][lookupAge];
    if (bmi < standard[0]) return { status: "過輕", color: "warning" };
    if (bmi >= standard[2]) return { status: "肥胖", color: "danger" };
    if (bmi >= standard[1]) return { status: "過重", color: "orange" };
    return { status: "正常", color: "success" };
}

function showMyQRCode() {
    if (!currentUserStudentId) return showAlert('錯誤', '無法取得學號', 'error');
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = ''; 
    new QRCode(qrContainer, { text: currentUserStudentId, width: 128, height: 128 });
    document.getElementById('qrDisplayArea').classList.remove('d-none'); 
}

function showAlert(title, message, type = 'info') {
    const titleEl = document.getElementById('msgModalTitle');
    const contentEl = document.getElementById('msgModalContent');
    const iconDiv = document.getElementById('msgModalIcon');
    if (!titleEl || !contentEl) return alert(`${title}: ${message}`);
    titleEl.textContent = title;
    contentEl.textContent = message;
    if(type === 'success') iconDiv.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i>';
    else if(type === 'error') iconDiv.innerHTML = '<i class="bi bi-x-circle-fill text-danger"></i>';
    else iconDiv.innerHTML = '<i class="bi bi-info-circle-fill text-primary"></i>';
    new bootstrap.Modal(document.getElementById('systemMessageModal')).show();
}

function playLoginAnimation(userName, callback) {
    const transitionLayer = document.getElementById('loginTransition');
    const text = document.getElementById('transitionText');
    text.textContent = `歡迎回來，${userName || '使用者'}！`;
    transitionLayer.classList.add('active');
    setTimeout(() => {
        if (callback) callback();
        setTimeout(() => {
            transitionLayer.classList.remove('active');
        }, 800);
    }, 1200);
}

function updateUserDisplay(data) {
    const display = document.getElementById('userEmailDisplay');
    if (data) {
        const school = data.school_name || '';
        const cls = data.class_name ? `${data.class_name}班` : '';
        const seat = data.seat_number ? `${data.seat_number}號` : '';
        display.textContent = `👤 ${school} ${cls} ${seat} ${data.name}`;
    } else {
        display.textContent = `👤 使用者`;
    }
}

// ================= 3. 維運與跑馬燈管理 =================

function checkMaintenanceMode(scope) {
    const overlay = document.getElementById('maintenanceOverlay');
    const modes = systemSettings.maintenance_mode;
    if (modes && modes[scope]) overlay.classList.remove('d-none');
    else overlay.classList.add('d-none');
}

function checkMarqueeStatus() {
    const marquee = document.getElementById('topMarquee');
    const marqueeTrack = document.getElementById('marqueeTrack');
    const settings = systemSettings.marquee_settings;

    if (settings && settings.enabled === true && settings.text && settings.text.trim() !== "") {
        marquee.classList.remove('d-none');
        document.body.classList.add('has-marquee'); 
        
        const text = settings.text + "　✦　"; 
        let contentHtml = "";
        for(let i=0; i<8; i++) {
            contentHtml += `<span class="marquee-item">${text}</span>`;
        }
        
        marqueeTrack.innerHTML = `
            <div class="marquee-block">${contentHtml}</div>
            <div class="marquee-block">${contentHtml}</div>
        `;
        
    } else {
        marquee.classList.add('d-none');
        document.body.classList.remove('has-marquee');
        marqueeTrack.innerHTML = '';
    }
}

async function loadSystemSettings() {
    const { data } = await supabaseClient.from('system_settings').select('*');
    if (data) {
        data.forEach(row => {
            if (row.key === 'maintenance_mode') systemSettings.maintenance_mode = row.value;
            if (row.key === 'marquee_settings') systemSettings.marquee_settings = row.value;
        });
    }
    checkMarqueeStatus();
}

async function saveSystemSettings(type = 'all') {
    const maintSettings = {
        login: document.getElementById('maintLogin').checked,
        student: document.getElementById('maintStudent').checked,
        teacher: document.getElementById('maintTeacher').checked,
        quick: document.getElementById('maintQuick').checked
    };
    
    const marqueeSettings = {
        enabled: document.getElementById('marqueeEnabled').checked,
        text: document.getElementById('marqueeContent').value
    };

    const updates = [
        { key: 'maintenance_mode', value: maintSettings },
        { key: 'marquee_settings', value: marqueeSettings }
    ];

    const { error } = await supabaseClient.from('system_settings').upsert(updates);

    if(error) {
        showAlert('錯誤', error.message, 'error');
    } else {
        systemSettings.maintenance_mode = maintSettings;
        systemSettings.marquee_settings = marqueeSettings;
        checkMarqueeStatus();
        if(!currentUserId) checkMaintenanceMode('login');

        let msgEl = null;
        if(type === 'marquee') msgEl = document.getElementById('adminSaveMsg_marquee');
        else if(type === 'maint') msgEl = document.getElementById('adminSaveMsg_maint');
        else msgEl = document.getElementById('adminSaveMsg_marquee');

        if(msgEl) {
            msgEl.textContent = "✅ 設定已儲存 (跑馬燈更新)";
            setTimeout(() => { msgEl.textContent = ""; }, 2000); 
        }
    }
}

function toggleView(isLoggedIn) {
    const authSection = document.getElementById('authSection');
    const mainApp = document.getElementById('mainApp');
    if (isLoggedIn) {
        authSection.classList.add('d-none'); authSection.classList.remove('d-flex'); mainApp.classList.remove('d-none');
    } else {
        mainApp.classList.add('d-none'); authSection.classList.remove('d-none'); authSection.classList.add('d-flex');
        checkMaintenanceMode('login');
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    }
}

function showSignup(role) {
    document.getElementById('loginCard').classList.add('d-none');
    document.getElementById('signupCard').classList.remove('d-none');
    const roleInput = document.getElementById('signupRole');
    const extra = document.getElementById('studentExtraFields');
    const alertBox = document.getElementById('teacherAlert');
    const btn = document.getElementById('signupBtnText');

    if (role === 'teacher') {
        roleInput.value = "teacher"; extra.style.display = 'none';
        document.getElementById('regStudentId').required = false; document.getElementById('regAge').required = false;
        alertBox.classList.remove('d-none'); btn.className = "btn btn-danger w-100 mb-3";
    } else {
        roleInput.value = "student"; extra.style.display = 'block';
        document.getElementById('regStudentId').required = true; document.getElementById('regAge').required = true;
        alertBox.classList.add('d-none'); btn.className = "btn btn-success w-100 mb-3";
    }
}

function showLogin() {
    document.getElementById('signupCard').classList.add('d-none');
    document.getElementById('loginCard').classList.remove('d-none');
}

function openCityModal() {
    checkMaintenanceMode('quick');
    if (systemSettings.maintenance_mode.quick) return;
    const modalBody = document.getElementById('cityButtonsArea');
    modalBody.innerHTML = '';
    taiwanCities.forEach(city => {
        modalBody.innerHTML += `<div class="col-4 col-md-3"><button class="btn btn-outline-secondary w-100 city-btn py-2 text-nowrap overflow-hidden" onclick="selectCity('${city}')">${city}</button></div>`;
    });
    new bootstrap.Modal(document.getElementById('cityModal')).show();
}

function selectCity(city) {
    bootstrap.Modal.getInstance(document.getElementById('cityModal')).hide();
    const schoolList = partnerSchools[city] || [];
    const listArea = document.getElementById('schoolListArea');
    document.getElementById('selectedCityTitle').textContent = city;
    listArea.innerHTML = '';
    if (schoolList.length > 0) {
        schoolList.forEach(school => {
            listArea.innerHTML += `<button type="button" class="list-group-item list-group-item-action py-3 text-primary fw-bold border-0 border-bottom" onclick="selectSchool('${school}')">${school}</button>`;
        });
    } else {
        listArea.innerHTML = `<div class="text-center py-4 text-muted small">此縣市合作學校陸續增加中...</div>`;
    }
    new bootstrap.Modal(document.getElementById('schoolModal')).show();
}

function selectSchool(school) {
    selectedSchoolName = school;
    bootstrap.Modal.getInstance(document.getElementById('schoolModal')).hide();
    document.getElementById('quickLoginSchoolName').textContent = `🏫 ${school}`;
    new bootstrap.Modal(document.getElementById('quickLoginModal')).show();
}

document.getElementById('quickLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const className = document.getElementById('quickClass').value;
    const seatNumber = document.getElementById('quickSeat').value;
    const { data, error } = await supabaseClient.from('students').select('*').eq('school_name', selectedSchoolName).eq('class_name', className).eq('seat_number', seatNumber).maybeSingle();

    if (error) showAlert('錯誤', error.message, 'error');
    else if (data) {
        bootstrap.Modal.getInstance(document.getElementById('quickLoginModal')).hide();
        playLoginAnimation(data.name, () => {
            currentUserId = data.id; currentUserRole = 'student';
            toggleView(true); updateUserDisplay(data); applyRoleUI('student'); initAppData();
        });
    } else {
        showAlert('找不到資料', '請確認輸入正確。', 'error');
    }
});

async function checkRole(userId) {
    const { data } = await supabaseClient.from('teachers_list').select('id, is_approved').eq('id', userId).maybeSingle();
    if (data) return data.is_approved ? 'teacher' : 'pending_teacher';
    return 'student';
}

function applyRoleUI(role) {
    const navs = ['navItemStudent', 'navItemProfile', 'navItemTeacher', 'navItemAdmin'];
    navs.forEach(id => document.getElementById(id).style.display = 'block');
    const badge = document.getElementById('roleBadge');

    if (role === 'teacher') {
        checkMaintenanceMode('teacher');
        document.getElementById('navItemStudent').style.display = 'none';
        document.getElementById('navItemProfile').style.display = 'none';
        badge.textContent = '老師版'; badge.className = 'badge bg-danger ms-2';
        new bootstrap.Tab(document.querySelector('#pills-teacher-tab')).show();
    } else {
        checkMaintenanceMode('student');
        document.getElementById('navItemTeacher').style.display = 'none';
        document.getElementById('navItemAdmin').style.display = 'none';
        badge.textContent = '學生版'; badge.className = 'badge bg-success ms-2';
        new bootstrap.Tab(document.querySelector('#pills-student-tab')).show();
    }
}

// ================= 4. 資料載入 =================

async function loadDevices() {
    try {
        const { data } = await supabaseClient.from('devices').select('*');
        const sel = document.getElementById('deviceSelect');
        sel.innerHTML = '';
        if (data) data.forEach(d => sel.innerHTML += `<option value="${d.id}">${d.device_name} (${d.type})</option>`);
        else sel.innerHTML = '<option value="">手動輸入 (Manual)</option>';
    } catch (e) {}
}

async function initAppData() {
    await loadDevices(); 
    if (currentUserRole === 'student') { 
        await loadStudentProfile(); 
        loadStudentData(); 
    } else { 
        await loadStudentListForTeacher(); 
        loadClassStats(); 
    }

    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
        if (currentUserRole === 'student') loadStudentData();
        else if (currentUserRole === 'teacher') {
            loadClassStats();
            const s2 = document.getElementById('teacherStudentSelect');
            if (s2) {
                const selectedStudent = s2.value;
                if(selectedStudent && !selectedStudent.includes('請選擇')) {
                    s2.dispatchEvent(new Event('change'));
                }
            }
        }
    }, 10000);
}

async function loadStudentProfile() {
    const { data: student } = await supabaseClient.from('students').select('*').eq('id', currentUserId).single();
    if (student) {
        updateUserDisplay(student); 
        document.getElementById('welcomeName').textContent = student.name;
        currentUserStudentId = student.student_id; 
        document.getElementById('profileName').value = student.name;
        document.getElementById('profileStudentId').value = student.student_id;
        document.getElementById('profileSchool').value = student.school_name || '';
        document.getElementById('profileClass').value = student.class_name || '';
        document.getElementById('profileSeat').value = student.seat_number || '';
        document.getElementById('profileAge').value = student.age || '';
        const { data: records } = await supabaseClient.from('health_records').select('*').eq('student_id', currentUserId).order('effective_datetime', { ascending: false });
        if(records && records.length) {
            const h = records.find(r => r.code === 'height'); const w = records.find(r => r.code === 'weight');
            if(h) document.getElementById('profileHeight').value = h.value;
            if(w) document.getElementById('profileWeight').value = w.value;
        }
    }
}

async function loadStudentData() {
    document.getElementById('qrDisplayArea').classList.add('d-none'); 
    const { data: student } = await supabaseClient.from('students').select('age, gender').eq('id', currentUserId).single();
    const { data: records } = await supabaseClient.from('health_records').select('*').eq('student_id', currentUserId).order('effective_datetime', { ascending: true });
    
    const getLatest = (code) => { const f = records.filter(r => r.code === code); return f.length ? Number(f[f.length - 1].value) : null; };
    const h = getLatest('height'), w = getLatest('weight'), run = getLatest('run800'), hr = getLatest('heartrate');
    let bmi = null; let bmiStatus = { status: '--', color: 'secondary' };
    if (h && w) { bmi = (w / ((h/100)**2)).toFixed(1); if (student) bmiStatus = getBMIStatus(bmi, student.age, student.gender); }

    document.getElementById('displayBMI').textContent = bmi || '--';
    const badge = document.getElementById('badgeBMI'); badge.textContent = bmiStatus.status; badge.className = `badge bg-${bmiStatus.color}`;
    document.getElementById('displayRun').textContent = run || '--'; document.getElementById('displayHeight').textContent = h || '--'; document.getElementById('displayHR').textContent = hr || '--';
    
    const adviceText = document.getElementById('adviceText'); let advice = [];
    advice.push(`BMI ${bmi || '?'} (${bmiStatus.status})`);
    if (bmiStatus.status.includes("過重") || bmiStatus.status.includes("肥胖")) advice.push("建議每週 150 分鐘運動，控制飲食。");
    else if (bmiStatus.status.includes("過輕")) advice.push("建議均衡飲食，增加肌力訓練。");
    else if (bmiStatus.status.includes("正常")) advice.push("體位標準，請繼續保持！");
    adviceText.innerHTML = advice.join(' | ');
    renderTrendChart(records);

    const historyBody = document.getElementById('studentHistoryTableBody');
    if (historyBody) {
        historyBody.innerHTML = '';
        [...records].reverse().forEach(r => {
            let typeName = r.code;
            if(r.code==='height') typeName='身高'; else if(r.code==='weight') typeName='體重'; else if(r.code==='run800') typeName='800m 跑'; else if(r.code==='heartrate') typeName='心率';
            const date = new Date(r.effective_datetime).toLocaleString();
            historyBody.innerHTML += `<tr><td>${typeName}</td><td class="fw-bold">${r.value}</td><td>${r.unit}</td><td class="text-muted small">${date}</td></tr>`;
        });
    }
}

function renderTrendChart(records) {
    const ctx = document.getElementById('trendChart').getContext('2d');
    if (myChart) myChart.destroy();

    const dates = [...new Set(records.map(r => new Date(r.effective_datetime).toLocaleDateString()))];
    const getData = (code) => {
        return records.filter(r => r.code === code).map(r => ({x: new Date(r.effective_datetime).toLocaleDateString(), y: r.value}));
    };

    const gradientWeight = ctx.createLinearGradient(0, 0, 0, 400);
    gradientWeight.addColorStop(0, 'rgba(13, 202, 240, 0.5)'); 
    gradientWeight.addColorStop(1, 'rgba(13, 202, 240, 0.0)');

    const gradientRun = ctx.createLinearGradient(0, 0, 0, 400);
    gradientRun.addColorStop(0, 'rgba(25, 135, 84, 0.5)'); 
    gradientRun.addColorStop(1, 'rgba(25, 135, 84, 0.0)');

    const gradientHR = ctx.createLinearGradient(0, 0, 0, 400);
    gradientHR.addColorStop(0, 'rgba(220, 53, 69, 0.5)'); 
    gradientHR.addColorStop(1, 'rgba(220, 53, 69, 0.0)');

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [
                {
                    label: '體重 (kg)',
                    data: getData('weight'),
                    borderColor: '#0dcaf0',
                    backgroundColor: gradientWeight,
                    fill: true,
                    tension: 0.4,
                    yAxisID: 'y'
                },
                {
                    label: '800m (秒)',
                    data: getData('run800'),
                    borderColor: '#198754',
                    backgroundColor: gradientRun,
                    fill: true,
                    tension: 0.4,
                    yAxisID: 'y1'
                },
                {
                    label: '心率 (bpm)',
                    data: getData('heartrate'),
                    borderColor: '#dc3545',
                    backgroundColor: gradientHR,
                    fill: true,
                    tension: 0.4,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { grid: { display: false } },
                y: { type: 'linear', display: true, position: 'left', title: {display:true, text:'體重'} },
                y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, title: {display:true, text:'秒數/bpm'} },
            }
        }
    });
}

// ================= 5. AUTH =================

document.addEventListener('DOMContentLoaded', async () => {
    await loadSystemSettings();
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) handleLoginSuccess(session, true); 
    else toggleView(false);
});

supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) handleLoginSuccess(session, false);
    else if (event === 'SIGNED_OUT') {
        currentUserId = null; currentUserRole = null;
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        toggleView(false);
    }
});

async function handleLoginSuccess(session, skipAnim = false) {
    currentUserId = session.user.id;
    currentUserRole = await checkRole(currentUserId);
    if (currentUserRole === 'pending_teacher') { showAlert('審核中', '您的老師帳號尚未通過審核。', 'info'); await supabaseClient.auth.signOut(); return; }

    const loadUI = () => {
        toggleView(true);
        document.getElementById('userEmailDisplay').textContent = `👤 ${session.user.email}`;
        applyRoleUI(currentUserRole);
        initAppData();
    };

    if (skipAnim) {
        checkMaintenanceMode(currentUserRole);
        loadUI();
    } else {
        let name = "使用者";
        if (currentUserRole === 'student') {
            const {data} = await supabaseClient.from('students').select('name').eq('id', currentUserId).maybeSingle(); if(data) name = data.name;
        } else {
            const {data} = await supabaseClient.from('teachers_list').select('name').eq('id', currentUserId).maybeSingle(); if(data) name = data.name;
        }
        playLoginAnimation(name, loadUI);
    }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) showAlert('登入失敗', error.message, 'error'); else document.getElementById('loginForm').reset();
});

document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = document.getElementById('signupRole').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    const name = document.getElementById('regName').value;
    if (password.length < 6) return showAlert('錯誤', '密碼需 6 碼以上', 'error');
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) { if (error.status === 422) showAlert('已註冊', '此 Email 已註冊，請直接登入。', 'info'); else showAlert('錯誤', error.message, 'error'); return; }
    if (data.user) {
        if (role === 'teacher') {
            const { error: dbError } = await supabaseClient.from('teachers_list').insert([{ id: data.user.id, name: name, email: email, is_approved: false }]);
            if (dbError) showAlert('錯誤', dbError.message, 'error');
            else { showAlert('申請已送出', '請等待管理員審核。', 'success'); await supabaseClient.auth.signOut(); showLogin(); }
        } else {
            const { error: dbError } = await supabaseClient.from('students').insert([{
                id: data.user.id,
                student_id: document.getElementById('regStudentId').value,
                name: name,
                school_name: document.getElementById('regSchool').value,
                class_name: document.getElementById('regClass').value,
                seat_number: document.getElementById('regSeat').value,
                gender: document.getElementById('regGender').value,
                age: document.getElementById('regAge').value,
                grade: 1
            }]);
            if (dbError) { if(dbError.message.includes("duplicate key")) showAlert('重複', '帳號已存在', 'info'); else showAlert('錯誤', dbError.message, 'error'); } else {
                const h = document.getElementById('regHeight').value; const w = document.getElementById('regWeight').value;
                if (h || w) { 
                    const rec = []; 
                    const now = new Date().toISOString(); 
                    if(h) rec.push({ student_id: data.user.id, code: 'height', value: h, unit: 'cm', effective_datetime: now }); 
                    if(w) rec.push({ student_id: data.user.id, code: 'weight', value: w, unit: 'kg', effective_datetime: now }); 
                    await supabaseClient.from('health_records').insert(rec); 
                    
                    // [FHIR] 註冊時同步建立 Patient
                    const studentData = {
                        student_id: document.getElementById('regStudentId').value,
                        name: name,
                        gender: document.getElementById('regGender').value
                    };
                    await syncPatientToFHIR(studentData);
                    
                    // [FHIR] 若有初始身高體重，也同步上傳
                    if(h) await syncObservationToFHIR(data.user.id, 'height', h, 'cm', now);
                    if(w) await syncObservationToFHIR(data.user.id, 'weight', w, 'kg', now);
                }
                showAlert('成功', '註冊成功！', 'success');
            }
        }
    }
});

async function logout() { 
    try { await supabaseClient.auth.signOut(); } 
    catch (e) {} 
    finally { localStorage.clear(); window.location.reload(); } 
}

document.getElementById('recordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sid = document.getElementById('teacherStudentSelect').value;
    if (!sid || sid.includes('請選擇')) return showAlert('錯誤', '請選擇一位學生', 'error');
    const devId = document.getElementById('deviceSelect').value;
    const type = document.getElementById('recordType').value;
    const val = document.getElementById('recordValue').value;
    let unit = 'unknown'; if (type === 'height') unit = 'cm'; if (type === 'weight') unit = 'kg'; if (type === 'run800') unit = 'sec'; if (type === 'heartrate') unit = 'bpm';
    
    const now = new Date().toISOString();
    const { error } = await supabaseClient.from('health_records').insert([{ student_id: sid, device_id: devId || null, code: type, value: val, unit: unit, effective_datetime: now }]);
    
    if (error) { showAlert('寫入失敗', error.message, 'error'); } 
    else { 
        // [FHIR] 同步上傳到 FHIR
        await syncObservationToFHIR(sid, type, val, unit, now);
        
        showAlert('成功', '數據已上傳！', 'success'); 
        document.getElementById('recordValue').value = ''; 
        loadClassStats();
        document.getElementById('teacherStudentSelect').dispatchEvent(new Event('change'));
    }
});

async function loadStudentListForTeacher() {
    const { data } = await supabaseClient.from('students').select('id, name, student_id').order('student_id');
    const s2 = document.getElementById('teacherStudentSelect');
    
    // [修復重點] 安全檢查：如果找不到元件，直接結束
    if (!s2) {
        console.warn("警告：找不到 id='teacherStudentSelect' 的下拉選單元件。");
        return;
    }

    s2.innerHTML = '<option selected disabled>請選擇學生...</option>';
    if (data) { 
        data.forEach(s => s2.innerHTML += `<option value="${s.id}" data-sid="${s.student_id}">${s.student_id} ${s.name}</option>`); 
    }

    // [優化] 使用 .onchange 取代 addEventListener
    s2.onchange = async (e) => {
        const studentId = e.target.value;
        const { data: student } = await supabaseClient.from('students').select('*').eq('id', studentId).single();
        const { data: history } = await supabaseClient.from('health_records').select('*').eq('student_id', studentId).order('effective_datetime', {ascending: false}).limit(3);
        
        const infoDiv = document.getElementById('teacherStudentInfo');
        const detailDiv = document.getElementById('teacherStudentDetail');
        if (infoDiv) infoDiv.classList.add('d-none');
        if (detailDiv) detailDiv.classList.remove('d-none');
        
        if (student) { 
            const setTxt = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
            setTxt('infoName', student.name);
            setTxt('infoSchool', student.school_name || '');
            setTxt('infoClass', student.class_name);
            setTxt('infoSeat', student.seat_number);
        }
        
        const list = document.getElementById('infoHistoryList');
        if (list) {
            list.innerHTML = '';
            if (history && history.length) { 
                history.forEach(r => { 
                    const date = new Date(r.effective_datetime).toLocaleDateString(); 
                    let type = r.code; 
                    if(type==='run800') type='800m'; 
                    else if(type==='height') type='身高'; 
                    else if(type==='weight') type='體重'; 
                    else if(type==='heartrate') type='心率'; 
                    
                    list.innerHTML += `
                        <li class="list-group-item d-flex justify-content-between align-items-center">
                            ${type} 
                            <span class="badge bg-light text-dark">${r.value} ${r.unit}</span> 
                            <small class="text-muted">${date}</small>
                        </li>`; 
                }); 
            } else { 
                list.innerHTML = '<li class="list-group-item text-muted">無歷史資料</li>'; 
            }
        }
    };
}

// 輔助函式 (掃描、檔案處理)
async function loadClassStats() { const { data: records } = await supabaseClient.from('health_records').select('*, students(name)'); if (!records || !records.length) return; const avg = (code) => { const v = records.filter(r => r.code === code).map(r => Number(r.value)); return v.length ? (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) : '--'; }; document.getElementById('avgRun').textContent = avg('run800'); document.getElementById('avgHR').textContent = avg('heartrate'); document.getElementById('avgBMI').textContent = '21.5'; const runs = records.filter(r => r.code === 'run800').map(r => Number(r.value)); const buckets = [0,0,0,0]; runs.forEach(v => { if (v < 200) buckets[0]++; else if (v < 250) buckets[1]++; else if (v < 300) buckets[2]++; else buckets[3]++; }); const ctx = document.getElementById('classHistogram').getContext('2d'); if (classChart) classChart.destroy(); classChart = new Chart(ctx, { type: 'bar', data: { labels: ['<200', '200-250', '250-300', '>300'], datasets: [{ label: '人數', data: buckets, backgroundColor: '#0d6efd' }] } }); }
document.getElementById('profileForm').addEventListener('submit', async (e) => { e.preventDefault(); const name = document.getElementById('profileName').value; const school = document.getElementById('profileSchool').value; const class_n = document.getElementById('profileClass').value; const seat = document.getElementById('profileSeat').value; const age = document.getElementById('profileAge').value; const height = document.getElementById('profileHeight').value; const weight = document.getElementById('profileWeight').value; const { error } = await supabaseClient.from('students').update({ name, school_name: school, class_name: class_n, seat_number: seat ? Number(seat) : null, age: age ? Number(age) : null }).eq('id', currentUserId); if (error) showAlert('錯誤', '儲存失敗', 'error'); else { 
    const records = []; const now = new Date().toISOString(); 
    if(height) { records.push({ student_id: currentUserId, code: 'height', value: height, unit: 'cm', effective_datetime: now }); }
    if(weight) { records.push({ student_id: currentUserId, code: 'weight', value: weight, unit: 'kg', effective_datetime: now }); }
    if(records.length > 0) {
        await supabaseClient.from('health_records').insert(records);
        // [FHIR] 更新個人資料時，同步身高體重
        if(height) await syncObservationToFHIR(currentUserId, 'height', height, 'cm', now);
        if(weight) await syncObservationToFHIR(currentUserId, 'weight', weight, 'kg', now);
    }
    showAlert('成功', '資料已更新', 'success'); loadStudentData(); loadStudentProfile(); 
} });
async function openDevAdmin() { 
    const pwd = prompt("密碼："); 
    if (pwd === "15110") { 
        document.getElementById('maintenanceOverlay').classList.add('d-none'); 
        new bootstrap.Modal(document.getElementById('devAdminModal')).show(); 
        
        loadDevUserList(); 
        
        const s = systemSettings.maintenance_mode || {}; 
        document.getElementById('maintLogin').checked = s.login; 
        document.getElementById('maintStudent').checked = s.student; 
        document.getElementById('maintTeacher').checked = s.teacher; 
        document.getElementById('maintQuick').checked = s.quick;

        const m = systemSettings.marquee_settings || { enabled: false, text: "" };
        document.getElementById('marqueeEnabled').checked = m.enabled;
        document.getElementById('marqueeContent').value = m.text || '';

    } else if (pwd !== null) showAlert('錯誤', '密碼錯誤', 'error'); 
}
function closeDevAdmin() { window.location.reload(); }
async function loadDevUserList() { const tbody = document.getElementById('devUserTableBody'); tbody.innerHTML = ''; const { data: s } = await supabaseClient.from('students').select('*'); const { data: t } = await supabaseClient.from('teachers_list').select('*'); if(t) t.forEach(x => { let status = x.is_approved ? '<span class="badge bg-primary">已啟用</span>' : '<span class="badge bg-warning text-dark">待審核</span>'; let btn = x.is_approved ? `<button class="btn btn-sm btn-outline-danger" onclick="devDelete('${x.id}','teacher')">刪</button>` : `<button class="btn btn-sm btn-success me-1" onclick="devApprove('${x.id}')">通</button><button class="btn btn-sm btn-outline-danger" onclick="devDelete('${x.id}','teacher')">駁</button>`; tbody.innerHTML += `<tr class="table-warning"><td>老師</td><td>${x.name}</td><td>${x.email}</td><td>${status}</td><td>${btn}</td></tr>`; }); if(s) s.forEach(x => { tbody.innerHTML += `<tr><td>學生</td><td>${x.name}</td><td>${x.student_id}</td><td>正常</td><td><button class="btn btn-sm btn-outline-secondary" onclick="devDelete('${x.id}','student')">刪</button></td></tr>`; }); }
async function devApprove(id) { await supabaseClient.from('teachers_list').update({is_approved:true}).eq('id',id); loadDevUserList(); }
async function devDelete(id, type) { if(!confirm('刪除？')) return; await supabaseClient.from(type==='student'?'students':'teachers_list').delete().eq('id',id); loadDevUserList(); }
async function exportCSV() { const {data:r} = await supabaseClient.from('health_records').select('*, students(name)'); let c="name,code,val\n"; r.forEach(x=>c+=`${x.students?.name},${x.code},${x.value}\n`); downloadFile(c,"rep.csv","text/csv"); }
function downloadFile(c,n,t){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([c],{type:t})); a.download=n; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
function startScanner() { const modal = new bootstrap.Modal(document.getElementById('scannerModal')); modal.show(); setTimeout(() => { if (html5QrcodeScanner) html5QrcodeScanner.clear(); html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 }); html5QrcodeScanner.render(onScanSuccess); }, 500); }
function onScanSuccess(t) { html5QrcodeScanner.clear(); bootstrap.Modal.getInstance(document.getElementById('scannerModal')).hide(); const s = document.getElementById('teacherStudentSelect'); for (let i = 0; i < s.options.length; i++) { if (s.options[i].getAttribute('data-sid') === t) { s.selectedIndex = i; break; } } alert(`已選取：${t}`); }
async function importFHIR() { const file = document.getElementById('fhirImportFile').files[0]; if (!file) return showAlert('錯誤', '請選擇檔案', 'error'); const reader = new FileReader(); reader.onload = async (e) => { try { const json = JSON.parse(e.target.result); const sId = json.entry.find(en => en.resource.resourceType === 'Patient')?.resource?.identifier?.[0]?.value; const { data: s } = await supabaseClient.from('students').select('id').eq('student_id', sId).single(); if (!s) throw new Error('無此學生'); for (const entry of json.entry.filter(en => en.resource.resourceType === 'Observation')) { const res = entry.resource; await supabaseClient.from('health_records').insert([{ student_id: s.id, code: 'imported', value: res.valueQuantity.value, unit: res.valueQuantity.unit, effective_datetime: new Date().toISOString() }]); } showAlert('成功', '匯入成功', 'success'); } catch (err) { showAlert('失敗', err.message, 'error'); } }; reader.readAsText(file); }
async function generateMockData() { if (!confirm('確定生成 30 筆模擬資料？')) return; const lastNames = ["陳", "林", "黃", "張", "李", "王", "吳", "劉", "蔡", "楊"]; const firstNames = ["志豪", "雅婷", "冠宇", "怡君", "承恩", "詩涵", "柏宇", "欣Yi", "家豪", "郁婷"]; const classes = ["101", "102", "103"]; const students = []; for (let i = 0; i < 30; i++) { const randName = lastNames[Math.floor(Math.random()*10)] + firstNames[Math.floor(Math.random()*10)]; const sid = "S" + (112000 + Math.floor(Math.random() * 9000)); students.push({ student_id: sid, name: randName, grade: 1, class_name: classes[Math.floor(Math.random() * 3)], gender: Math.random() > 0.5 ? 'male' : 'female', school_name: '臺北市萬芳高級中學', age: 16 }); } const { data: createdStudents, error: errS } = await supabaseClient.from('students').insert(students).select(); if (errS) return showAlert('失敗', errS.message, 'error'); const records = []; createdStudents.forEach(s => { const h = (150 + Math.random() * 35).toFixed(1); const w = (45 + Math.random() * 40).toFixed(1); const run = (160 + Math.random() * 200).toFixed(0); const hr = (60 + Math.random() * 60).toFixed(0); const now = new Date().toISOString(); records.push({ student_id: s.id, code: 'height', value: h, unit: 'cm', effective_datetime: now }); records.push({ student_id: s.id, code: 'weight', value: w, unit: 'kg', effective_datetime: now }); records.push({ student_id: s.id, code: 'run800', value: run, unit: 'sec', effective_datetime: now }); records.push({ student_id: s.id, code: 'heartrate', value: hr, unit: 'bpm', effective_datetime: now }); }); const { error: errR } = await supabaseClient.from('health_records').insert(records); if (errR) showAlert('失敗', errR.message, 'error'); else { showAlert('成功', '成功生成測試資料！', 'success'); window.location.reload(); } }
async function exportFHIR() { const sid = document.getElementById('teacherStudentSelect').value; if (!sid) return showAlert('錯誤', '請選擇學生', 'error'); const { data: s } = await supabaseClient.from('students').select('*').eq('id', sid).single(); const { data: rs } = await supabaseClient.from('health_records').select('*').eq('student_id', sid); const bundle = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Patient", id: s.id, name: [{ text: s.name }], identifier: [{ value: s.student_id }] } }] }; rs.forEach(r => bundle.entry.push({ resource: { resourceType: "Observation", code: { coding: [{ code: r.code }] }, valueQuantity: { value: Number(r.value), unit: r.unit }, subject: { reference: `Patient/${s.id}` } } })); downloadFile(JSON.stringify(bundle, null, 2), `fhir_${s.student_id}.json`, 'application/json'); }