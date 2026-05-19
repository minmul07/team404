const API_URL = '/api';
const socketProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

socket.onopen = () => {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('server-status-text');
  if (dot) dot.className = 'dot online';
  if (text) text.innerText = '서버 연결됨 (운영 중)';
};

socket.onclose = () => {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('server-status-text');
  if (dot) dot.className = 'dot offline';
  if (text) text.innerText = '서버 연결 끊김';
};

socket.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'FILE_EVENT':
      addLogEntry(msg.payload);
      break;
    case 'QUARANTINE_COMPLETED':
      loadState();
      console.log('새로운 파일 격리됨!');
      break;
  }
};

async function loadState() {
  try {
    const [snapshotRes, alertsRes, incidentsRes] = await Promise.all([
      fetch(`${API_URL}/snapshot`),
      fetch(`${API_URL}/alerts`),
      fetch(`${API_URL}/incidents`)
    ]);
    const snapshot = await snapshotRes.json();
    const alerts = await alertsRes.json();
    const incidents = await incidentsRes.json();

    const target = snapshot.activeTarget;
    document.getElementById('target-path').innerText =
      (target?.rootPath ?? target) || '없음';
    updateQuarantineTable(snapshot.quarantineJobs ?? []);
    updateQuarantineTable_bjh(snapshot.quarantineJobs ?? []);
    updateLog(alerts.items ?? [], incidents.items ?? []);
  } catch (err) {
    console.error('데이터 로드 실패', err);
  }
}

async function loadInitialState() {
  return loadState();
}

async function handleDemoStart() {
  const btn = document.getElementById('btn-demo-start');
  const originalText = btn?.innerText ?? '데모 시작';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '시작 중...';
  }

  try {
    const response = await fetch(`${API_URL}/demo/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      showNotification('데모 시작됨');
      await loadState();
    } else {
      const error = await response.json();
      alert(`데모 시작 실패: ${error.error || '알 수 없는 오류'}`);
    }
  } catch (err) {
    console.error(err);
    alert('데모 시작 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }
}

async function handleDemoStop() {
  const btn = document.getElementById('btn-demo-stop');
  const originalText = btn?.innerText ?? '데모 중지';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '중지 중...';
  }

  try {
    const response = await fetch(`${API_URL}/demo/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      showNotification('데모 중지됨');
      await loadState();
    } else {
      const error = await response.json();
      alert(`데모 중지 실패: ${error.error || '알 수 없는 오류'}`);
    }
  } catch (err) {
    console.error(err);
    alert('데모 중지 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }
}

async function handleRestore(incidentId) {
  const btn = event.target;
  btn.disabled = true;
  btn.innerText = '복원 중...';

  try {
    const response = await fetch(`${API_URL}/incidents/${incidentId}/restore`, {
      method: 'POST'
    });

    if (response.ok) {
      alert('권한 복원이 완료되었습니다.');
      loadState();
    } else {
      const error = await response.json();
      alert(`오류: ${error.error}`);
    }
  } catch (err) {
    alert('복원 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    btn.disabled = false;
    btn.innerText = '복구';
  }
}

document.getElementById('btn-demo-start')?.addEventListener('click', handleDemoStart);
document.getElementById('btn-demo-stop')?.addEventListener('click', handleDemoStop);

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

function updateQuarantineTable_bjh(jobs) {
  const list = document.getElementById('quarantine-list-bjh');
  if (!list) return;
  document.getElementById('quarantine-count-bjh').innerText = jobs.length;
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

function updateLog(alerts, incidents = []) {
  const container = document.getElementById('log-container');
  if (alerts.length === 0 && incidents.filter(i => i.status === 'restored').length === 0) {
    container.innerHTML = '<div style="color:#475569;padding:8px 0;font-style:italic">대기 중 — 이벤트 없음</div>';
    return;
  }

  const restoreEntries = incidents
    .filter(i => i.status === 'restored')
    .map(i => ({
      _type: 'restore',
      observedAt: i.updatedAt,
      rootPath: i.monitorRootPath,
      samplePaths: i.samplePaths ?? []
    }));

  const allEntries = [
    ...alerts.map(a => ({ _type: 'alert', ...a })),
    ...restoreEntries
  ].sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt)).slice(0, 20);

  const entries = [];
  for (const entry of allEntries) {
    if (entry._type === 'restore') {
      const time = new Date(entry.observedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const files = (entry.samplePaths ?? [])
        .map(p => p.replace(/\\/g, '/').split('/').pop().replace('.demo.locked', ''))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 5);
      entries.push(`
        <div style="margin-bottom:10px;padding:8px 10px;background:#0f172a;border-radius:6px;border-left:3px solid #22c55e">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
            <span style="color:#64748b;font-size:0.78em;font-family:monospace">${time}</span>
            <span style="background:#052e16;color:#22c55e;font-size:0.72em;font-weight:700;padding:1px 6px;border-radius:3px;letter-spacing:0.05em">RESTORED</span>
            <span style="color:#22c55e;font-weight:700;font-size:0.82em">권한 복원 완료</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${files.map(f => `<span style="background:#1e293b;color:#cbd5e1;font-size:0.75em;padding:2px 7px;border-radius:4px;font-family:monospace">${f}</span>`).join('')}
          </div>
        </div>`);
      continue;
    }
    const alert = entry;
    const time = new Date(alert.observedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const type = alert.eventType?.toUpperCase() ?? 'MATCH';
    const severity = alert.severity?.toUpperCase() ?? 'HIGH';
    const files = (alert.samplePaths ?? [])
      .map(p => p.replace(/\\/g, '/').split('/').pop().replace('.demo.locked', ''))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 5);

    const typeColor = type === 'MODIFY' ? '#ef4444' : type === 'CREATE' ? '#f97316' : '#a855f7';
    const sevColor = severity === 'CRITICAL' ? '#dc2626' : severity === 'HIGH' ? '#ea580c' : '#ca8a04';
    const sevBg = severity === 'CRITICAL' ? '#450a0a' : severity === 'HIGH' ? '#431407' : '#422006';

    entries.push(`
      <div style="margin-bottom:10px;padding:8px 10px;background:#0f172a;border-radius:6px;border-left:3px solid ${typeColor}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="color:#64748b;font-size:0.78em;font-family:monospace">${time}</span>
          <span style="background:${sevBg};color:${sevColor};font-size:0.72em;font-weight:700;padding:1px 6px;border-radius:3px;letter-spacing:0.05em">${severity}</span>
          <span style="color:${typeColor};font-weight:700;font-size:0.82em">${type}</span>
          <span style="color:#94a3b8;font-size:0.82em">${alert.ruleName ?? ''}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${files.map(f => `<span style="background:#1e293b;color:#cbd5e1;font-size:0.75em;padding:2px 7px;border-radius:4px;font-family:monospace">${f}</span>`).join('')}
        </div>
        <div style="color:#475569;font-size:0.72em;margin-top:4px">${alert.reason ?? ''}</div>
      </div>`);
  }
  container.innerHTML = entries.join('');
}

function addLogEntry(payload) {
  const container = document.getElementById('log-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `log-entry ${payload.type}`;
  div.innerHTML = `<strong>[${payload.type}]</strong> ${payload.path} (PID: ${payload.pid})`;
  container.prepend(div);
}

function showNotification(msg) {
  const el = document.createElement('div');
  el.className = 'notification';
  el.innerText = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function checkHealth() {
  try {
    await fetch(`${API_URL}/health`);
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('server-status-text');
    if (dot && !dot.classList.contains('online')) dot.style.backgroundColor = '#4caf50';
    if (text && text.innerText === '서버 연결 중...') text.innerText = '서버 연결됨';
  } catch {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('server-status-text');
    if (dot && !dot.classList.contains('offline')) dot.style.backgroundColor = '#f44336';
    if (text) text.innerText = '서버 연결 끊김';
  }
}

loadState();
checkHealth();
setInterval(loadState, 3000);
setInterval(checkHealth, 5000);
