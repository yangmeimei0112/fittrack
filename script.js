// --------------------------------------------------------
// FitTrack 符合 SA/SD 架構版 (FHIR Core) - Fixed
// --------------------------------------------------------

const SUPABASE_URL = 'https://szhdnodigzybxwnftdgm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6aGRub2RpZ3p5Ynh3bmZ0ZGdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3NzM0NjYsImV4cCI6MjA4MDM0OTQ2Nn0.5evNyYmufJ9KaWYw4QsD4btgrQDMkIiYNbUhEaf52NE';

// [SA/SD 架構] FHIR Server 作為核心健康資料庫 [cite: 4, 19]
const FHIR_SERVER_URL = 'https://hapi.fhir.org/baseR4';

// 初始化 Supabase (僅依據 SD 1.1/1.2 用於帳號與學生基本資料) 
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

// ================= 1. FHIR 核心互動層 (模擬 Backend API 行為) =================

// 取得學生的 FHIR Patient ID (依據 SD 1.2: 透過 Identifier 對應) [cite: 41, 42]
async function getFHIRPatientId(studentId) {
    const fhirIdentifier = `fittrack-${studentId}`;
    const searchUrl = `${FHIR_SERVER_URL}/Patient?identifier=${fhirIdentifier}`;
    try {
        const resp = await fetch(searchUrl);
        const data = await resp.json();
        if (data.entry && data.entry.length > 0) {
            return data.entry[0].resource.id;
        }
        return null;
    } catch (err) {
        console.error("FHIR Patient Search Error:", err);
        return null;
    }
}

// 建立或取得 FHIR Patient (Student Module)
async function syncPatientToFHIR(studentData) {
    const fhirIdentifier = `fittrack-${studentData.student_id}`;
    const existingId = await getFHIRPatientId(studentData.student_id);
    
    if (existingId) return existingId;

    // 若不存在，建立新病人
    const newPatient = {
        resourceType: "Patient",
        identifier: [{ 
            system: "https://github.com/yangmeimei0112/fittrack", 
            value: fhirIdentifier 
        }],
        name: [{ text: studentData.name }],
        gender: studentData.gender === 'male' ? 'male' : 'female',
        active: true
    };

    try {
        const createResp = await fetch(`${FHIR_SERVER_URL}/Patient`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newPatient)
        });
        const createData = await createResp.json();
        return createData.id;
    } catch (err) {
        console.error("Create Patient Error:", err);
        return null;
    }
}

// [SA/SD 核心修正] 讀取健康資料來源改為 FHIR Server
// 符合 SA 4: Analytics Module 透過 FHIR API 讀取資料 [cite: 28, 103]
// 符合 SD 2.2: GET /fhir/Observation?subject=Patient/{id} [cite: 73]
async function fetchFHIRObservations(studentIdStr) {
    const patientId = await getFHIRPatientId(studentIdStr);
    if (!patientId) return [];

    // 查詢該病人的所有 Observation，並依時間倒序
    const url = `${FHIR_SERVER_URL}/Observation?subject=Patient/${patientId}&_sort=-date&_count=50`;
    
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        
        if (!data.entry) return [];

        // 解析 FHIR Bundle 為前端好用的格式
        return data.entry.map(entry => {
            const r = entry.resource;
            // 解析 LOINC 或 自定義 Code
            let code = 'unknown';
            const coding = r.code?.coding?.[0];
            if (coding) {
                if (coding.code === '8302-2') code = 'height';
                else if (coding.code === '29463-7') code = 'weight';
                else if (coding.code === '8867-4') code = 'heartrate';
                else if (coding.code === 'X-RUN800' || coding.code === '800m') code = 'run800'; 
            }

            return {
                code: code,
                value: r.valueQuantity?.value,
                unit: r.valueQuantity?.unit,
                effective_datetime: r.effectiveDateTime
            };
        });

    } catch (e) {
        console.error("FHIR Fetch Error:", e);
        return [];
    }
}

// [SA/SD 核心修正] 寫入資料直接 POST 到 FHIR (不再寫入 Supabase health_records)
// 符合 SD 1.3: 不再自行設 observations 資料表 [cite: 45]
// 符合 SD 2.1: POST /fhir/Observation 
async function postFHIRObservation(studentDbId, code, value, unit, date) {
    // 1. 取得學生基本資料以獲取學號 (Supabase 只負責基本資料)
    const { data: student } = await supabaseClient.from('students').select('*').eq('id', studentDbId).single();
    if (!student) throw new Error("Student not found in Auth DB");

    // 2. 確保 FHIR 有此 Patient
    const fhirPatientId = await syncPatientToFHIR(student);
    if (!fhirPatientId) throw new Error("Failed to sync Patient to FHIR");

    // 3. 對應 Code (LOINC) [cite: 56]
    let loincCode = "unknown";
    let display = "unknown";
    if (code === 'height') { loincCode = '8302-2'; display = 'Body height'; }
    else if (code === 'weight') { loincCode = '29463-7'; display = 'Body weight'; }
    else if (code === 'heartrate') { loincCode = '8867-4'; display = 'Heart rate'; }
    else if (code === 'run800') { loincCode = 'X-RUN800'; display = '800m Run'; }

    // 4. 建立 Observation Resource (SD 1.3 JSON 範例) [cite: 47-66]
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

    // 5. POST 到 FHIR Server
    const resp = await fetch(`${FHIR_SERVER_URL}/Observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(observation)
    });

    if (!resp.ok) throw new Error("FHIR Server Error: " + resp.statusText);
    return await resp.json();
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
    const marqueeTrack = document.getElementById('marqueeTrack'); // 需注意 HTML 中可能缺此ID，若無會略過
    const settings = systemSettings.marquee_settings;
    // 因為 index.html 中可能沒有 marquee 結構，這裡僅做邏輯保留，不強求 DOM 操作
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
    
    // 開發者後台可能沒有 marquee 相關輸入框，做安全檢查
    const marqueeSettings = { enabled: false, text: "" };

    const updates = [{ key: 'maintenance_mode', value: maintSettings }];

    const { error } = await supabaseClient.from('system_settings').upsert(updates);

    if(error) {
        showAlert('錯誤', error.message, 'error');
    } else {
        systemSettings.maintenance_mode = maintSettings;
        checkMarqueeStatus();
        if(!currentUserId) checkMaintenanceMode('login');
        
        let msgEl = document.getElementById('adminSaveMsg');
        if(msgEl) {
            msgEl.textContent = "✅ 設定已儲存";
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

// ================= 4. 資料載入 (邏輯更新：讀取 FHIR) =================

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
        }
    }, 15000); // 避免頻繁打 FHIR
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
        
        // [SA/SD 修正] 個人資料中的身高體重，改從 FHIR 抓取最新值
        const fhirData = await fetchFHIRObservations(student.student_id);
        if(fhirData && fhirData.length) {
            const h = fhirData.find(r => r.code === 'height'); 
            const w = fhirData.find(r => r.code === 'weight');
            if(h) document.getElementById('profileHeight').value = h.value;
            if(w) document.getElementById('profileWeight').value = w.value;
        }
    }
}

// [核心變更] 完全依賴 FHIR 資料更新介面 (符合 SD 1.3/2.2)
async function loadStudentData() {
    document.getElementById('qrDisplayArea').classList.add('d-none'); 
    
    // 1. 取得學生基本資料 (年齡性別用於 BMI 計算)
    const { data: student } = await supabaseClient.from('students').select('student_id, age, gender').eq('id', currentUserId).single();
    
    if(!student) return;

    // 2. 從 FHIR 取得健康紀錄 (取代 Supabase health_records) [cite: 19]
    const records = await fetchFHIRObservations(student.student_id);
    
    // 整理數據 (因為 fetchFHIRObservations 已經依照時間倒序，第 0 筆就是最新的)
    const getLatest = (code) => { const r = records.find(r => r.code === code); return r ? Number(r.value) : null; };
    
    const h = getLatest('height');
    const w = getLatest('weight');
    const run = getLatest('run800');
    const hr = getLatest('heartrate');
    
    // BMI 計算 (符合 SD 3: 從 FHIR 取得數據計算) [cite: 79]
    let bmi = null; let bmiStatus = { status: '--', color: 'secondary' };
    if (h && w) { 
        bmi = (w / ((h/100)**2)).toFixed(1); 
        if (student) bmiStatus = getBMIStatus(bmi, student.age, student.gender); 
    }

    // 更新 UI
    document.getElementById('displayBMI').textContent = bmi || '--';
    const badge = document.getElementById('badgeBMI'); badge.textContent = bmiStatus.status; badge.className = `badge bg-${bmiStatus.color}`;
    document.getElementById('displayRun').textContent = run || '--'; 
    document.getElementById('displayHeight').textContent = h || '--'; 
    document.getElementById('displayHR').textContent = hr || '--';
    
    const adviceText = document.getElementById('adviceText'); let advice = [];
    advice.push(`BMI ${bmi || '?'} (${bmiStatus.status})`);
    if (bmiStatus.status.includes("過重") || bmiStatus.status.includes("肥胖")) advice.push("建議每週 150 分鐘運動，控制飲食。");
    else if (bmiStatus.status.includes("過輕")) advice.push("建議均衡飲食，增加肌力訓練。");
    else if (bmiStatus.status.includes("正常")) advice.push("體位標準，請繼續保持！");
    adviceText.innerHTML = advice.join(' | ');
    
    // 繪製圖表 (Analytics Module 顯示分析) [cite: 28]
    renderTrendChart(records); 

    // 歷史列表
    const historyBody = document.getElementById('studentHistoryTableBody');
    if (historyBody) {
        historyBody.innerHTML = '';
        records.forEach(r => {
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

    // 資料已經從 FHIR 解析好，需要反轉順序 (舊->新) 供圖表顯示
    const chartData = [...records].reverse(); 
    
    const dates = [...new Set(chartData.map(r => new Date(r.effective_datetime).toLocaleDateString()))];
    
    const getData = (code) => {
        return chartData.filter(r => r.code === code).map(r => ({
            x: new Date(r.effective_datetime).toLocaleDateString(), 
            y: r.value
        }));
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
                { label: '體重 (kg)', data: getData('weight'), borderColor: '#0dcaf0', backgroundColor: gradientWeight, fill: true, tension: 0.4, yAxisID: 'y' },
                { label: '800m (秒)', data: getData('run800'), borderColor: '#198754', backgroundColor: gradientRun, fill: true, tension: 0.4, yAxisID: 'y1' },
                { label: '心率 (bpm)', data: getData('heartrate'), borderColor: '#dc3545', backgroundColor: gradientHR, fill: true, tension: 0.4, yAxisID: 'y1' }
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

// ================= 5. AUTH 與事件處理 =================

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
    
    // 註冊帳號 (Auth Module)
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) { 
        if (error.status === 422) showAlert('已註冊', '此 Email 已註冊，請直接登入。', 'info'); 
        else showAlert('錯誤', error.message, 'error'); 
        return; 
    }

    if (data.user) {
        if (role === 'teacher') {
            const { error: dbError } = await supabaseClient.from('teachers_list').insert([{ id: data.user.id, name: name, email: email, is_approved: false }]);
            if (dbError) showAlert('錯誤', dbError.message, 'error');
            else { showAlert('申請已送出', '請等待管理員審核。', 'success'); await supabaseClient.auth.signOut(); showLogin(); }
        } else {
            const sid = document.getElementById('regStudentId').value;
            const { error: dbError } = await supabaseClient.from('students').insert([{
                id: data.user.id,
                student_id: sid,
                name: name,
                school_name: document.getElementById('regSchool').value,
                class_name: document.getElementById('regClass').value,
                seat_number: document.getElementById('regSeat').value,
                gender: document.getElementById('regGender').value,
                age: document.getElementById('regAge').value,
                grade: 1
            }]);

            if (dbError) { 
                if(dbError.message.includes("duplicate key")) showAlert('重複', '帳號已存在', 'info'); 
                else showAlert('錯誤', dbError.message, 'error'); 
            } else {
                // [FHIR] 註冊時建立病人 (Student Module - Map to Patient) [cite: 23]
                const studentData = { student_id: sid, name: name, gender: document.getElementById('regGender').value };
                await syncPatientToFHIR(studentData);
                
                // 處理初始身高體重，僅寫入 FHIR (SD 1.3)
                const h = document.getElementById('regHeight').value; 
                const w = document.getElementById('regWeight').value;
                const now = new Date().toISOString();
                
                try {
                    if(h) await postFHIRObservation(data.user.id, 'height', h, 'cm', now);
                    if(w) await postFHIRObservation(data.user.id, 'weight', w, 'kg', now);
                } catch(fhirErr) {
                    console.error("FHIR Init Error", fhirErr);
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

// [核心變更] 老師輸入數據表單：移除 Supabase health_records 寫入
document.getElementById('recordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sid = document.getElementById('teacherStudentSelect').value;
    if (!sid || sid.includes('請選擇')) return showAlert('錯誤', '請選擇一位學生', 'error');
    const type = document.getElementById('recordType').value;
    const val = document.getElementById('recordValue').value;
    let unit = 'unknown'; if (type === 'height') unit = 'cm'; if (type === 'weight') unit = 'kg'; if (type === 'run800') unit = 'sec'; if (type === 'heartrate') unit = 'bpm';
    
    const now = new Date().toISOString();
    
    try {
        // [SD 2.1] Backend 轉送至 FHIR (此處模擬) [cite: 70]
        await postFHIRObservation(sid, type, val, unit, now);
        
        showAlert('成功', '數據已上傳至 FHIR Server！', 'success'); 
        document.getElementById('recordValue').value = ''; 
        loadClassStats(); // 刷新班級統計
        
        // 觸發重新讀取學生歷史
        document.getElementById('teacherStudentSelect').dispatchEvent(new Event('change'));
    } catch (error) {
        showAlert('寫入失敗', error.message, 'error');
    }
});

async function loadStudentListForTeacher() {
    const { data } = await supabaseClient.from('students').select('id, name, student_id').order('student_id');
    const s2 = document.getElementById('teacherStudentSelect');
    
    if (!s2) return;

    s2.innerHTML = '<option selected disabled>請選擇學生...</option>';
    if (data) { 
        data.forEach(s => s2.innerHTML += `<option value="${s.id}" data-sid="${s.student_id}">${s.student_id} ${s.name}</option>`); 
    }

    s2.onchange = async (e) => {
        const studentId = e.target.value; // Supabase ID
        // 這裡需要用 student_id (學號) 去查 FHIR
        const studentOption = s2.options[s2.selectedIndex];
        const studentNo = studentOption.getAttribute('data-sid');

        const { data: student } = await supabaseClient.from('students').select('*').eq('id', studentId).single();
        
        // [FHIR] 讀取最近歷史 (Analytics Module - Read from FHIR) [cite: 23]
        const history = await fetchFHIRObservations(studentNo);
        const recentHistory = history.slice(0, 3); // 取最近 3 筆

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
            if (recentHistory && recentHistory.length) { 
                recentHistory.forEach(r => { 
                    const date = new Date(r.effective_datetime).toLocaleDateString(); 
                    let type = r.code; 
                    if(type==='run800') type='800m'; else if(type==='height') type='身高'; else if(type==='weight') type='體重'; else if(type==='heartrate') type='心率'; 
                    list.innerHTML += `<li class="list-group-item d-flex justify-content-between align-items-center">${type} <span class="badge bg-light text-dark">${r.value} ${r.unit}</span> <small class="text-muted">${date}</small></li>`; 
                }); 
            } else { 
                list.innerHTML = '<li class="list-group-item text-muted">FHIR 上無資料</li>'; 
            }
        }
    };
}

// 模擬班級統計 (簡化版：不遍歷 FHIR，僅提供示意功能，因為純前端遍歷全班 FHIR 太慢)
// 符合 SA: Analytics Module 透過 FHIR 讀取，這裡做前端模擬
async function loadClassStats() { 
    document.getElementById('avgRun').textContent = '--'; 
    document.getElementById('avgHR').textContent = '--'; 
    document.getElementById('avgBMI').textContent = '--'; 
    // 若要真實實作，需對班級內所有學生迴圈呼叫 fetchFHIRObservations，效能考量暫略
}

// 更新個人資料
document.getElementById('profileForm').addEventListener('submit', async (e) => { 
    e.preventDefault(); 
    const name = document.getElementById('profileName').value; 
    const school = document.getElementById('profileSchool').value; 
    const class_n = document.getElementById('profileClass').value; 
    const seat = document.getElementById('profileSeat').value; 
    const age = document.getElementById('profileAge').value; 
    
    // 基本資料存 Supabase (SD 1.2 users/students) [cite: 32]
    const { error } = await supabaseClient.from('students').update({ name, school_name: school, class_name: class_n, seat_number: seat ? Number(seat) : null, age: age ? Number(age) : null }).eq('id', currentUserId); 
    
    if (error) showAlert('錯誤', '儲存失敗', 'error'); 
    else { 
        // 身高體重存 FHIR (SD 1.3) [cite: 44]
        const height = document.getElementById('profileHeight').value; 
        const weight = document.getElementById('profileWeight').value; 
        const now = new Date().toISOString(); 
        
        try {
            if(height) await postFHIRObservation(currentUserId, 'height', height, 'cm', now);
            if(weight) await postFHIRObservation(currentUserId, 'weight', weight, 'kg', now);
            showAlert('成功', '資料已更新 (FHIR 同步完成)', 'success'); 
            loadStudentData(); 
            loadStudentProfile(); 
        } catch(err) {
            showAlert('警告', '基本資料更新成功，但 FHIR 連線失敗', 'warning');
        }
    } 
});

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
    } else if (pwd !== null) showAlert('錯誤', '密碼錯誤', 'error'); 
}

function closeDevAdmin() { window.location.reload(); }
async function loadDevUserList() { const tbody = document.getElementById('devUserTableBody'); tbody.innerHTML = ''; const { data: s } = await supabaseClient.from('students').select('*'); const { data: t } = await supabaseClient.from('teachers_list').select('*'); if(t) t.forEach(x => { let status = x.is_approved ? '<span class="badge bg-primary">已啟用</span>' : '<span class="badge bg-warning text-dark">待審核</span>'; let btn = x.is_approved ? `<button class="btn btn-sm btn-outline-danger" onclick="devDelete('${x.id}','teacher')">刪</button>` : `<button class="btn btn-sm btn-success me-1" onclick="devApprove('${x.id}')">通</button><button class="btn btn-sm btn-outline-danger" onclick="devDelete('${x.id}','teacher')">駁</button>`; tbody.innerHTML += `<tr class="table-warning"><td>老師</td><td>${x.name}</td><td>${x.email}</td><td>${status}</td><td>${btn}</td></tr>`; }); if(s) s.forEach(x => { tbody.innerHTML += `<tr><td>學生</td><td>${x.name}</td><td>${x.student_id}</td><td>正常</td><td><button class="btn btn-sm btn-outline-secondary" onclick="devDelete('${x.id}','student')">刪</button></td></tr>`; }); }
async function devApprove(id) { await supabaseClient.from('teachers_list').update({is_approved:true}).eq('id',id); loadDevUserList(); }
async function devDelete(id, type) { if(!confirm('刪除？')) return; await supabaseClient.from(type==='student'?'students':'teachers_list').delete().eq('id',id); loadDevUserList(); }

// 匯出 CSV 
async function exportCSV() { alert("需後端支援 FHIR 批次匯出，目前前端版本暫不支援全域 CSV"); }
function downloadFile(c,n,t){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([c],{type:t})); a.download=n; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
function startScanner() { const modal = new bootstrap.Modal(document.getElementById('scannerModal')); modal.show(); setTimeout(() => { if (html5QrcodeScanner) html5QrcodeScanner.clear(); html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 }); html5QrcodeScanner.render(onScanSuccess); }, 500); }
function onScanSuccess(t) { html5QrcodeScanner.clear(); bootstrap.Modal.getInstance(document.getElementById('scannerModal')).hide(); const s = document.getElementById('teacherStudentSelect'); for (let i = 0; i < s.options.length; i++) { if (s.options[i].getAttribute('data-sid') === t) { s.selectedIndex = i; break; } } alert(`已選取：${t}`); }

// FHIR 匯入功能 (符合 SD 2.3) [cite: 74, 105]
async function importFHIR() { 
    const file = document.getElementById('fhirImportFile').files[0]; 
    if (!file) return showAlert('錯誤', '請選擇檔案', 'error'); 
    const reader = new FileReader(); 
    reader.onload = async (e) => { 
        try { 
            const json = JSON.parse(e.target.result); 
            // 直接 POST 到 FHIR Server
            if(json.resourceType === 'Bundle') {
                for (const entry of json.entry) {
                    if(entry.resource.resourceType === 'Observation') {
                         await fetch(`${FHIR_SERVER_URL}/Observation`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(entry.resource)
                        });
                    }
                }
            }
            showAlert('成功', 'FHIR 資料已匯入至伺服器', 'success'); 
        } catch (err) { showAlert('失敗', err.message, 'error'); } 
    }; 
    reader.readAsText(file); 
}

// 模擬資料生成 (同時寫入 Students DB 與 FHIR)
async function generateMockData() { 
    if (!confirm('確定生成 5 筆模擬資料？')) return; 
    const lastNames = ["陳", "林", "黃", "張", "李", "王", "吳", "劉", "蔡", "楊"]; 
    const firstNames = ["志豪", "雅婷", "冠宇", "怡君", "承恩", "詩涵", "柏宇", "欣Yi", "家豪", "郁婷"]; 
    const classes = ["101", "102", "103"]; 
    
    for (let i = 0; i < 5; i++) { // 減少數量避免 FHIR 請求過多被擋
        const randName = lastNames[Math.floor(Math.random()*10)] + firstNames[Math.floor(Math.random()*10)]; 
        const sid = "S" + (112000 + Math.floor(Math.random() * 9000)); 
        const gender = Math.random() > 0.5 ? 'male' : 'female';
        
        // 1. 寫入 Supabase (Auth/Student)
        const { data: s, error } = await supabaseClient.from('students').insert([{ student_id: sid, name: randName, grade: 1, class_name: classes[Math.floor(Math.random() * 3)], gender: gender, school_name: '臺北市萬芳高級中學', age: 16 }]).select().single();
        
        if (!error && s) {
             // 2. 寫入 FHIR (Observation)
             const now = new Date().toISOString();
             const h = (150 + Math.random() * 35).toFixed(1); 
             const w = (45 + Math.random() * 40).toFixed(1);
             
             await postFHIRObservation(s.id, 'height', h, 'cm', now);
             await postFHIRObservation(s.id, 'weight', w, 'kg', now);
             await postFHIRObservation(s.id, 'run800', (160 + Math.random() * 200).toFixed(0), 'sec', now);
        }
    } 
    showAlert('成功', '成功生成測試資料 (已同步至 FHIR)！', 'success'); 
}