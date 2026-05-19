const API_URL = '/api';
const VIEW_COPY = {
  dashboard: {
    title: '대시보드',
    subtitle: '파일 이벤트와 격리 상태를 실시간으로 확인합니다.'
  },
  rules: {
    title: '탐지 규칙',
    subtitle: '규칙 편집 화면이 연결되기 전까지 비어있는 상태로 유지됩니다.'
  },
  settings: {
    title: '설정',
    subtitle: '운영 설정 화면이 연결되기 전까지 비어있는 상태로 유지됩니다.'
  }
};

const socketProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

socket.onopen = () => {
  setServerStatus('online', '서버 연결됨 (운영 중)');
};

socket.onclose = () => {
  setServerStatus('offline', '서버 연결 끊김');
};

socket.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'FILE_EVENT':
      addLogEntry(msg.payload);
      break;
    case 'QUARANTINE_COMPLETED':
    case 'RESTORE_COMPLETED':
    case 'RULE_MATCH':
    case 'SYSTEM_HEALTH':
      loadState();
      break;
  }
};

function setServerStatus(status, label) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('server-status-text');
  if (dot) dot.className = `dot ${status}`;
  if (text) text.innerText = label;
}

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
    const targetPath = (target?.rootPath ?? target) || '없음';
    document.getElementById('target-path').innerText = targetPath;
    updateQuarantineTable(snapshot.quarantineJobs ?? []);
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

async function handleRestore(incidentId, btn) {
  const originalText = btn?.innerText ?? '복구';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '복원 중...';
  }

  try {
    const response = await fetch(`${API_URL}/incidents/${incidentId}/restore`, {
      method: 'POST'
    });

    if (response.ok) {
      showNotification('권한 복원이 완료되었습니다.');
      await loadState();
    } else {
      const error = await response.json();
      alert(`오류: ${error.error}`);
    }
  } catch (err) {
    console.error(err);
    alert('복원 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }
}

function updateQuarantineTable(jobs) {
  const list = document.getElementById('quarantine-list');
  const count = document.getElementById('quarantine-count');
  if (count) count.innerText = jobs.length;
  if (!list) return;

  if (jobs.length === 0) {
    list.innerHTML = `
      <tr>
        <td class="empty-row" colspan="5">격리 중인 Incident가 없습니다.</td>
      </tr>
    `;
    return;
  }

  list.innerHTML = jobs.map(job => `
    <tr>
      <td>${escapeHtml(job.incidentId.substring(0, 8))}...</td>
      <td class="path-cell" title="${escapeHtml(job.rootPath)}">${escapeHtml(job.rootPath)}</td>
      <td>${Number(job.entryCount) || 0}개</td>
      <td><span class="badge danger">격리(400/500)</span></td>
      <td>
        <button class="btn-restore" type="button" data-incident-id="${escapeHtml(job.incidentId)}">복구</button>
      </td>
    </tr>
  `).join('');
}

function updateLog(alerts, incidents = []) {
  const container = document.getElementById('log-container');
  if (!container) return;

  const restoredIncidents = incidents.filter(i => i.status === 'restored');
  if (alerts.length === 0 && restoredIncidents.length === 0) {
    container.innerHTML = '<div class="empty-state">대기 중 - 이벤트 없음</div>';
    return;
  }

  const restoreEntries = restoredIncidents.map(i => ({
    _type: 'restore',
    observedAt: i.updatedAt,
    rootPath: i.monitorRootPath,
    samplePaths: i.samplePaths ?? []
  }));

  const allEntries = [
    ...alerts.map(a => ({ _type: 'alert', ...a })),
    ...restoreEntries
  ].sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt)).slice(0, 20);

  container.innerHTML = allEntries.map((entry) => {
    if (entry._type === 'restore') {
      return renderRestoreEntry(entry);
    }
    return renderAlertEntry(entry);
  }).join('');
}

function renderRestoreEntry(entry) {
  const time = formatTime(entry.observedAt);
  const files = extractFileNames(entry.samplePaths);
  return `
    <div class="log-entry restore">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity low">RESTORED</span>
        <span class="log-type">권한 복원 완료</span>
      </div>
      ${renderFileChips(files)}
    </div>
  `;
}

function renderAlertEntry(alert) {
  const time = formatTime(alert.observedAt);
  const type = alert.eventType?.toUpperCase() ?? 'MATCH';
  const severity = alert.severity?.toUpperCase() ?? 'HIGH';
  const typeClass = `alert-${type.toLowerCase()}`;
  const severityClass = severity.toLowerCase();
  const files = extractFileNames(alert.samplePaths);

  return `
    <div class="log-entry ${typeClass}">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${escapeHtml(severityClass)}">${escapeHtml(severity)}</span>
        <span class="log-type">${escapeHtml(type)}</span>
        <span class="log-rule">${escapeHtml(alert.ruleName ?? '')}</span>
      </div>
      ${renderFileChips(files)}
      <div class="log-reason">${escapeHtml(alert.reason ?? '')}</div>
    </div>
  `;
}

function addLogEntry(payload) {
  const container = document.getElementById('log-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `log-entry ${payload.type}`;
  div.innerHTML = `<strong>[${escapeHtml(payload.type)}]</strong> ${escapeHtml(payload.path)} (PID: ${escapeHtml(String(payload.pid ?? '-'))})`;
  container.prepend(div);
}

function renderFileChips(files) {
  if (files.length === 0) return '';
  return `
    <div class="file-list">
      ${files.map(f => `<span class="file-chip">${escapeHtml(f)}</span>`).join('')}
    </div>
  `;
}

function extractFileNames(paths = []) {
  return paths
    .map(p => String(p).replace(/\\/g, '/').split('/').pop().replace('.demo.locked', ''))
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .slice(0, 5);
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
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
    const text = document.getElementById('server-status-text');
    if (text && text.innerText === '서버 연결 중...') {
      setServerStatus('online', '서버 연결됨');
    }
  } catch {
    setServerStatus('offline', '서버 연결 끊김');
  }
}

function switchView(viewName) {
  const view = VIEW_COPY[viewName] ? viewName : 'dashboard';
  document.querySelectorAll('[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
    panel.classList.toggle('active', panel.dataset.viewPanel === view);
  });

  const copy = VIEW_COPY[view];
  document.getElementById('view-title').innerText = copy.title;
  document.getElementById('view-subtitle').innerText = copy.subtitle;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

document.getElementById('btn-demo-start')?.addEventListener('click', handleDemoStart);
document.getElementById('btn-demo-stop')?.addEventListener('click', handleDemoStop);

document.querySelector('.menu')?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-view]');
  if (!item) return;
  switchView(item.dataset.view);
});

document.getElementById('quarantine-list')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-incident-id]');
  if (!btn) return;
  handleRestore(btn.dataset.incidentId, btn);
});

loadInitialState();
checkHealth();
setInterval(loadState, 3000);
setInterval(checkHealth, 5000);
