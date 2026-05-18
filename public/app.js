const API_URL = '/api';
const socket = new WebSocket(`ws://${window.location.host}`);

// --- [추가] 웹소켓 연결 상태를 UI에 반영 ---
socket.onopen = () => {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('server-status-text');
    if (dot && text) {
        dot.className = 'dot online';
        text.innerText = '서버 연결됨 (운영 중)';
    }
};

socket.onclose = () => {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('server-status-text');
    if (dot && text) {
        dot.className = 'dot offline';
        text.innerText = '서버 연결 끊김';
    }
};

// --- [추가 및 수정] 데모 제어 함수 구현 ---
async function handleDemoStart() {
    const btn = document.getElementById('btn-demo-start');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "시작 중...";

    try {
        const response = await fetch(`${API_URL}/demo/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            alert("보안 모니터링 데모 시나리오가 시작되었습니다.");
            loadInitialState(); // 상태 새로고침
        } else {
            const error = await response.json();
            alert(`데모 시작 실패: ${error.error || '알 수 없는 오류'}`);
        }
    } catch (err) {
        console.error(err);
        alert("데모 시작 요청 중 네트워크 오류가 발생했습니다.");
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

async function handleDemoStop() {
    const btn = document.getElementById('btn-demo-stop');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "중지 중...";

    try {
        const response = await fetch(`${API_URL}/demo/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            alert("데모 시나리오가 중지되었습니다.");
            loadInitialState(); // 상태 새로고침
        } else {
            const error = await response.json();
            alert(`데모 중지 실패: ${error.error || '알 수 없는 오류'}`);
        }
    } catch (err) {
        console.error(err);
        alert("데모 중지 요청 중 네트워크 오류가 발생했습니다.");
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

// --- 기존 핵심 기능 유지 및 문법 에러 수정 ---
async function loadInitialState() {
    try {
        const response = await fetch(`${API_URL}/snapshot`);
        if (!response.ok) throw new Error('Snapshot 로드 실패');
        
        const data = await response.json();
        document.getElementById('target-path').innerText = data.activeTarget || '없음';
        updateQuarantineTable(data.quarantineJobs || []);
    } catch (err) {
        console.error("데이터 로드 실패", err);
    }
}

async function handleRestore(incidentId) {
    const btn = event.target;
    btn.disabled = true;
    btn.innerText = "복원 중...";
    try {
        const response = await fetch(`${API_URL}/incidents/${incidentId}/restore`, {
            method: 'POST'
        });
        if (response.ok) {
            alert("권한 복원이 완료되었습니다.");
            loadInitialState();
        } else {
            const error = await response.json();
            alert(`오류: ${error.error}`);
        }
    } catch (err) {
        alert("복원 요청 중 네트워크 오류가 발생했습니다.");
    } finally {
        btn.disabled = false;
        btn.innerText = "복구";
    }
}

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch(msg.type) {
        case 'FILE_EVENT': 
            addLogEntry(msg.payload);
            break;
        case 'QUARANTINE_COMPLETED':
            loadInitialState();
            // 브라우저 기본 알림 알럿 혹은 커스텀 UI 알림 처리
            console.log("새로운 파일 격리됨!");
            break;
    }
};

function updateQuarantineTable(jobs) {
    const list = document.getElementById('quarantine-list');
    document.getElementById('quarantine-count').innerText = jobs.length;
    list.innerHTML = jobs.map(job => `
        <tr>
            <td>${job.incidentId.substring(0, 8)}...</td>
            <td title="${job.rootPath}">${job.rootPath}</td>
            <td>${job.entryCount}개</td>
            <td><span class="badge danger">격리(400/500)</span></td>
            <td><button class="btn-restore" onclick="handleRestore('${job.incidentId}')">복구</button></td>
        </tr>
    `).join('');
}

function addLogEntry(payload) {
    const container = document.getElementById('log-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `log-entry ${payload.type}`;
    div.innerHTML = `<strong>[${payload.type}]</strong> ${payload.path} (PID: ${payload.pid})`;
    container.prepend(div);
}

// 초기 데이터 바인딩 실행
loadInitialState();