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
      appendFsEventEntry(normalizeFileEvent(msg.payload));
      break;
    case 'RULE_MATCH':
    case 'QUARANTINE_STARTED':
    case 'QUARANTINE_COMPLETED':
    case 'QUARANTINE_FAILED':
    case 'RESTORE_COMPLETED':
      appendIncidentEntry(normalizeIncidentEvent(msg));
      loadState(); // refresh stats + quarantine table
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

    const qCount = document.getElementById('quarantine-count');
    if (qCount) qCount.innerText = snapshot.quarantineJobs?.length ?? 0;

    const wCount = document.getElementById('watching-count');
    if (wCount) wCount.innerText = snapshot.watchEnabled ? '1' : '0';

    updateWatchButtonLabel(snapshot.watchEnabled);

    updateQuarantineTable(snapshot.quarantineJobs ?? []);

    renderIncidentTable(incidents.items ?? []);
  } catch (err) {
    console.error('데이터 로드 실패', err);
  }
}

async function loadInitialState() {
  return loadState();
}


function updateWatchButtonLabel(enabled) {
  const btn = document.getElementById('btn-watch-toggle');
  if (btn) {
    btn.innerText = enabled ? '감시 중지' : '감시 시작';
    btn.dataset.enabled = String(enabled);
  }
}

async function handleWatchToggle() {
  const btn = document.getElementById('btn-watch-toggle');
  if (!btn) return;
  btn.disabled = true;
  const nextEnabled = btn.dataset.enabled !== 'true';

  try {
    const response = await fetch(`${API_URL}/watch/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextEnabled })
    });

    if (response.ok) {
      const data = await response.json();
      updateWatchButtonLabel(data.watchEnabled);
      const wCount = document.getElementById('watching-count');
      if (wCount) wCount.innerText = data.watchEnabled ? '1' : '0';
      showNotification(data.watchEnabled ? '감시가 시작되었습니다.' : '감시가 중지되었습니다.');
    } else {
      const error = await response.json();
      alert(`감시 토글 실패: ${error.error || '알 수 없는 오류'}`);
    }
  } catch (err) {
    console.error(err);
    alert('감시 토글 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    btn.disabled = false;
  }
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

  list.innerHTML = jobs.map(job => {
    const status = job.status ?? 'quarantined';
    const statusLabel = getStatusLabel(status);
    const canRestore = status === 'quarantined';
    return `
    <tr>
      <td>${escapeHtml(job.incidentId.substring(0, 8))}...</td>
      <td class="path-cell" title="${escapeHtml(job.rootPath)}">${escapeHtml(job.rootPath)}</td>
      <td>${Number(job.entryCount) || 0}개</td>
      <td><span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span></td>
      <td>
        ${canRestore
          ? `<button class="btn-restore" type="button" data-incident-id="${escapeHtml(job.incidentId)}">복구</button>`
          : `<span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>`}
      </td>
    </tr>
  `;
  }).join('');
}

function getStatusLabel(status) {
  const labels = {
    quarantining: '격리 중',
    quarantined: '격리됨',
    failed: '실패',
    restored: '복구됨'
  };
  return labels[status] ?? status;
}


function renderIncidentTable(incidents) {
  const list = document.getElementById('quarantine-list');
  if (!list) return;

  if (incidents.length === 0) {
    list.innerHTML = `
      <tr>
        <td class="empty-row" colspan="5">등록된 Incident가 없습니다.</td>
      </tr>
    `;
    return;
  }

  list.innerHTML = incidents.map(inc => {
    const id = inc.id ?? inc.incidentId ?? '-';
    const path = inc.monitorRootPath ?? '-';
    const count = (inc.samplePaths ?? []).length;
    const status = inc.status ?? 'open';
    const statusLabel = getStatusLabel(status);
    const shortId = String(id).substring(0, 8);
    const canRestore = status === 'quarantined';

    return `
    <tr>
      <td>${escapeHtml(shortId)}...</td>
      <td class="path-cell" title="${escapeHtml(path)}">${escapeHtml(path)}</td>
      <td>${count}개</td>
      <td><span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span></td>
      <td>
        ${canRestore
          ? `<button class="btn-restore" type="button" data-incident-id="${escapeHtml(id)}">복구</button>`
          : `<span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>`}
      </td>
    </tr>
  `;
  }).join('');
}


function appendFsEventEntry(entry) {
  const container = document.getElementById('fs-event-log-container');
  if (!container) return;

  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.innerHTML = renderFileEventEntry(entry);
  const child = el.firstElementChild;
  if (!child) return;

  child.style.opacity = '0';
  child.style.transform = 'translateY(-8px)';
  child.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
  container.prepend(child);

  requestAnimationFrame(() => {
    child.style.opacity = '1';
    child.style.transform = 'translateY(0)';
  });

  while (container.children.length > 100) {
    container.lastElementChild?.remove();
  }
}


function appendIncidentEntry(entry) {
  const container = document.getElementById('incident-log-container');
  if (!container) return;

  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  let html;
  switch (entry._type) {
    case 'rule_match':
      html = renderAlertEntry(entry);
      break;
    case 'quarantine':
      html = renderQuarantineEntry(entry);
      break;
    case 'restore':
      html = renderRestoreEntry(entry);
      break;
    default:
      html = renderAlertEntry(entry);
  }

  const el = document.createElement('div');
  el.innerHTML = html;
  const child = el.firstElementChild;
  if (!child) return;

  child.style.opacity = '0';
  child.style.transform = 'translateY(-8px)';
  child.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
  container.prepend(child);

  requestAnimationFrame(() => {
    child.style.opacity = '1';
    child.style.transform = 'translateY(0)';
  });

  while (container.children.length > 100) {
    container.lastElementChild?.remove();
  }
}


function normalizeFileEvent(payload) {
  return {
    _type: 'file',
    eventType: payload.type ?? 'event',
    path: payload.path,
    pid: payload.pid,
    observedAt: payload.observedAt ?? new Date().toISOString()
  };
}

function normalizeIncidentEvent(msg) {
  const payload = msg.payload ?? {};
  switch (msg.type) {
    case 'RULE_MATCH':
      return {
        _type: 'rule_match',
        ruleId: payload.ruleId,
        ruleName: payload.ruleName,
        severity: payload.severity,
        reason: payload.reason,
        samplePaths: payload.samplePaths ?? [],
        observedAt: payload.observedAt ?? new Date().toISOString()
      };
    case 'QUARANTINE_STARTED':
    case 'QUARANTINE_COMPLETED':
    case 'QUARANTINE_FAILED':
      return {
        _type: 'quarantine',
        status: msg.type.replace('QUARANTINE_', '').toLowerCase(),
        incidentId: payload.incidentId,
        rootPath: payload.rootPath,
        entryCount: payload.entryCount,
        observedAt: payload.observedAt ?? new Date().toISOString()
      };
    case 'RESTORE_COMPLETED':
      return {
        _type: 'restore',
        incidentId: payload.incidentId,
        rootPath: payload.rootPath,
        observedAt: payload.observedAt ?? new Date().toISOString()
      };
    default:
      return { _type: 'alert', ...payload, observedAt: payload.observedAt ?? new Date().toISOString() };
  }
}


function renderRestoreEntry(entry) {
  const time = formatTime(entry.observedAt);
  return `
    <div class="log-entry restore">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity low">RESTORED</span>
        <span class="log-type">권한 복원 완료</span>
      </div>
      <div class="log-reason">ID: ${escapeHtml(entry.incidentId ?? '-')}</div>
    </div>
  `;
}

function renderAlertEntry(alert) {
  const time = formatTime(alert.observedAt);
  const type = alert.ruleId ? 'RULE_MATCH' : (alert.eventType?.toUpperCase() ?? 'MATCH');
  const severity = alert.severity?.toUpperCase() ?? 'HIGH';
  const typeClass = `alert-${type.toLowerCase().replace(/_/g, '-')}`;
  const severityClass = severity.toLowerCase();

  return `
    <div class="log-entry ${typeClass}">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${escapeHtml(severityClass)}">${escapeHtml(severity)}</span>
        <span class="log-type">${escapeHtml(type)}</span>
        ${alert.ruleName ? `<span class="log-rule">${escapeHtml(alert.ruleName)}</span>` : ''}
      </div>
      ${alert.samplePaths?.length ? renderFileChips(extractFileNames(alert.samplePaths)) : ''}
      ${alert.reason ? `<div class="log-reason">${escapeHtml(alert.reason)}</div>` : ''}
    </div>
  `;
}

function renderQuarantineEntry(entry) {
  const time = formatTime(entry.observedAt);
  const statusLabel = entry.status.toUpperCase();
  const severityClass = entry.status === 'completed' ? 'success' : entry.status === 'failed' ? 'danger' : 'low';

  return `
    <div class="log-entry alert-quarantine">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${severityClass}">${escapeHtml(statusLabel)}</span>
        <span class="log-type">QUARANTINE</span>
      </div>
      <div class="log-path">${escapeHtml(entry.rootPath ?? '-')}</div>
      <div class="log-reason">ID: ${escapeHtml(entry.incidentId ?? '-')} · ${Number(entry.entryCount) || 0}개 항목</div>
    </div>
  `;
}

function renderFileEventEntry(entry) {
  const time = formatTime(entry.observedAt);
  const type = String(entry.eventType ?? 'event').toUpperCase();
  const typeClass = `file-${type.toLowerCase()}`;
  return `
    <div class="log-entry ${escapeHtml(typeClass)}">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity low">FILE</span>
        <span class="log-type">${escapeHtml(type)}</span>
      </div>
      <div class="log-path">${escapeHtml(entry.path ?? '')}</div>
      <div class="log-reason">PID: ${escapeHtml(String(entry.pid ?? '-'))}</div>
    </div>
  `;
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
document.getElementById('btn-watch-toggle')?.addEventListener('click', handleWatchToggle);

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
setInterval(checkHealth, 5000);
