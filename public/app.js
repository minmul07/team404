const API_URL = '/api';
const socket = new WebSocket(`ws://${window.location.host}`);

async function loadInitialState() {
    try {
        const response = await fetch(`${API_URL}/snapshot`); // runtime.getSnapshot() 호출 [cite: 16]
        const data = await response.json();
        
        document.getElementById('target-path').innerText = data.activeTarget || '없음';
        updateQuarantineTable(data.quarantineJobs); // [cite: 37, 39]
    } catch (err) {
        console.error("데이터 로드 실패", err);
    }
}


async function handleRestore(incidentId) {
    const btn = event.target;
    btn.disabled = true;
    btn.innerText = "복원 중...";

    try {
        // 백엔드의 /api/incidents/:id/restore 매칭 [cite: 50, 51]
        const response = await fetch(`${API_URL}/incidents/${incidentId}/restore`, {
            method: 'POST'
        });

        if (response.ok) {
            alert("권한 복원이 완료되었습니다."); // restorePermissions 실행 완료 [cite: 47, 48]
            loadInitialState(); // UI 새로고침
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
            showNotification("새로운 파일 격리됨!");
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
    const div = document.createElement('div');
    div.className = `log-entry ${payload.type}`;
    div.innerHTML = `<strong>[${payload.type}]</strong> ${payload.path} (PID: ${payload.pid})`;
    container.prepend(div);
}


loadInitialState();