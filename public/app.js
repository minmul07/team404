const API_URL = '/api';
const THEME_STORAGE_KEY = 'sentinel-dashboard-theme';
const DEFAULT_THEME = 'light';

const VIEW_COPY = {
  dashboard: {
    title: '대시보드',
    subtitle: '파일 이벤트와 격리 상태를 실시간으로 확인합니다.'
  },
  rules: {
    title: '탐지 규칙',
    subtitle: '확장자 분류와 파일 이벤트별 감시 가중치를 조정합니다.'
  },
  settings: {
    title: '설정',
    subtitle: '탐지 후 자동 대응 단계를 설정합니다.'
  }
};

const DEFAULT_DETECTION_POLICY = {
  thresholdWeight: 10,
  weights: {
    knownExtension: 0.1,
    unknownExtension: 1,
    noExtension: 1,
    suspiciousExtension: 2
  },
  eventMultipliers: {
    create: 1,
    modify: 1,
    rename: 1.5
  },
  weightDecay: {
    intervalMs: 1000,
    amount: 1
  },
  userAllowedExtensions: [],
  suspiciousExtensions: ['locked', 'encrypted', 'warning', 'decrypt', 'ransom', 'recover', 'pay']
};

let detectionPolicyDraft = cloneDetectionPolicy(DEFAULT_DETECTION_POLICY);
const pendingRuleWeightsByPath = new Map();
let latestRuleWeight = null;
let latestSnapshot = null;
let latestResponsePolicy = null;

applyTheme(loadThemePreference());

const socketProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

socket.onopen = () => {
  setServerStatus('online', '메인 서버 연결됨 (감시 및 격리)');
};

socket.onclose = () => {
  setServerStatus('offline', '메인 서버 연결 끊김');
  setDemoServerStatus('offline', '데모 서버 연결 끊김');
};

socket.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'CONNECTED':
      updateDemoServerStatus({ demo: msg.payload?.demo });
      updateMonitorBackendStatus(msg.payload);
      break;
    case 'SYSTEM_HEALTH':
      updateMonitorBackendStatus(msg.payload?.details ?? msg.payload);
      break;
    case 'RULE_WEIGHT_UPDATED':
      cacheRuleWeight(msg.payload);
      latestRuleWeight = normalizeRuleWeight(msg.payload);
      updateRuleWeightDisplay(latestRuleWeight);
      break;
    case 'FILE_EVENT':
      appendFsEventEntry(normalizeFileEvent(msg.payload));
      break;
    case 'RULE_MATCH':
    case 'QUARANTINE_STARTED':
    case 'QUARANTINE_COMPLETED':
    case 'QUARANTINE_FAILED':
    case 'RESTORE_COMPLETED':
    case 'DEMO_STARTED':
    case 'DEMO_ABORTED':
    case 'DEMO_COMPLETED':
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

function setDemoServerStatus(status, label) {
  const dot = document.getElementById('demo-status-dot');
  const text = document.getElementById('demo-server-status-text');
  if (dot) dot.className = `dot ${status}`;
  if (text) text.innerText = label;
}

function loadThemePreference() {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  return storedTheme === 'dark' ? 'dark' : DEFAULT_THEME;
}

function applyTheme(theme) {
  const nextTheme = theme === 'dark' ? 'dark' : DEFAULT_THEME;
  document.documentElement.dataset.theme = nextTheme;
  document.querySelectorAll('input[name="dashboard-theme"]').forEach((input) => {
    input.checked = input.value === nextTheme;
  });
}

function handleThemeChange(event) {
  const input = event.target.closest('input[name="dashboard-theme"]');
  if (!input) return;
  const nextTheme = input.value === 'dark' ? 'dark' : DEFAULT_THEME;
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
}

function updateDemoServerStatus(snapshot = {}) {
  const demo = snapshot.demo ?? {};
  const warning = demo.privilegeWarning;

  if (demo.status === 'running' || demo.status === 'stopping') {
    const pid = demo.workerPid ? `PID ${demo.workerPid}` : '';
    const uid = Number.isInteger(demo.runAsUid) ? `UID ${demo.runAsUid}` : '';
    const suffix = [pid, uid].filter(Boolean).join(' / ');
    setDemoServerStatus(
      warning ? 'warning' : 'online',
      warning ? '데모 서버 실행 중 (권한 분리 비활성)' : `데모 서버 실행 중${suffix ? ` (${suffix})` : ''}`
    );
    return;
  }

  if (demo.status === 'failed') {
    setDemoServerStatus('warning', '데모 서버 중단됨');
    return;
  }

  if (warning) {
    setDemoServerStatus('warning', '데모 서버 대기 (권한 분리 비활성)');
    return;
  }

  setDemoServerStatus('idle', '데모 서버 대기');
}

function updateMonitorBackendStatus(snapshot = {}) {
  const monitor = snapshot.monitor ?? snapshot.health?.monitor ?? snapshot;
  const activeBackend = monitor.activeBackend ?? snapshot.activeBackend;
  const requestedBackend = monitor.requestedBackend ?? snapshot.requestedBackend ?? 'auto';
  const fallbackReason = monitor.fallbackReason ?? snapshot.fallbackReason;
  const pidTrackingAvailable = Boolean(monitor.pidTrackingAvailable ?? snapshot.pidTrackingAvailable);
  const status = monitor.status ?? snapshot.status;

  if (latestResponsePolicy) {
    updateResponsePolicyControls(latestResponsePolicy, { monitor });
  }

  if (fallbackReason) {
    setServerStatus('warning', formatMonitorFallbackSummary(activeBackend));
    return;
  }

  if (status === 'degraded') {
    setServerStatus('warning', `감시 degraded (${requestedBackend})`);
    return;
  }

  if (activeBackend) {
    const pidLabel = pidTrackingAvailable ? ' / PID 추적' : '';
    setServerStatus('online', `메인 서버 연결됨 (${activeBackend}${pidLabel})`);
    return;
  }

  setServerStatus('online', '메인 서버 연결됨 (감시 및 격리)');
}

function formatMonitorFallbackSummary(activeBackend = 'inotify') {
  const backend = activeBackend || 'inotify';
  return `감시 모드: ${backend} (auditd 사용 불가로 자동 전환)`;
}

function formatMonitorFallbackDetails(activeBackend = 'inotify', fallbackReason = '') {
  const backend = activeBackend || 'inotify';
  const reason = fallbackReason ? ` (${fallbackReason})` : '';
  return `활성화: ${backend} / auditd 사용 불가로 자동 전환${reason}`;
}


async function loadState() {
  try {
    const snapshotRes = await fetch(`${API_URL}/snapshot`);
    const snapshot = await snapshotRes.json();
    latestSnapshot = snapshot;

    const targetPaths = getSnapshotTargetPaths(snapshot);
    document.getElementById('target-path').innerText = targetPaths.length > 0
      ? targetPaths.join('\n')
      : '없음';

    const wCount = document.getElementById('watching-count');
    if (wCount) wCount.innerText = String(snapshot.watchedFileCount ?? 0);

    updateDemoServerStatus(snapshot);
    updateMonitorBackendStatus(snapshot);
    updateWatchButtonLabel(snapshot.watchEnabled);
    updateWatchTargetControls(snapshot);
    updateDemoControls(snapshot);
    updateDemoSettingsControls(snapshot);
    updateMonitorSettingsControls(snapshot);
    updateResponsePolicyControls(snapshot.responsePolicy, snapshot);
    updateDetectionPolicyControls(snapshot.detectionPolicy);
    updateRuleWeightDisplay(latestRuleWeight ?? {
      currentWeight: 0,
      thresholdWeight: snapshot.detectionPolicy?.thresholdWeight ?? DEFAULT_DETECTION_POLICY.thresholdWeight
    });

    updateQuarantineTable(snapshot.quarantineJobs ?? []);
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
    btn.classList.toggle('active', enabled);
  }
}

function updateWatchTargetControls(snapshot) {
  const mode = snapshot.activeMode === 'demo' ? 'demo' : 'normal';
  const applyBtn = document.getElementById('btn-watch-target-apply');
  const error = document.getElementById('watch-target-error');
  const targetPaths = getSnapshotTargetPaths(snapshot);

  document.querySelectorAll('input[name="watch-mode"]').forEach((radio) => {
    radio.checked = radio.value === mode;
  });

  renderWatchTargetRows(targetPaths, mode === 'demo');

  if (applyBtn) {
    applyBtn.disabled = mode === 'demo';
  }

  if (error) {
    error.hidden = true;
    error.innerText = '';
  }
}

function getSnapshotTargetPaths(snapshot = {}) {
  const targets = Array.isArray(snapshot.targets)
    ? snapshot.targets
    : (Array.isArray(snapshot.health?.monitor?.targets) ? snapshot.health.monitor.targets : []);
  const paths = targets
    .map((target) => target?.rootPath ?? target)
    .filter(Boolean);

  if (paths.length === 0) {
    const activeTarget = snapshot.activeTarget?.rootPath ?? snapshot.activeTarget;
    if (activeTarget) {
      paths.push(activeTarget);
    }
  }

  return [...new Set(paths)];
}

function renderWatchTargetRows(targetPaths, disabled = false) {
  const container = document.getElementById('watch-target-list');
  if (!container) return;

  const activeInput = document.activeElement?.closest?.('.watch-target-input');
  if (activeInput) {
    document.querySelectorAll('.watch-target-input').forEach((input) => {
      input.disabled = disabled;
      input.classList.remove('invalid');
    });
    return;
  }

  const rowPaths = targetPaths.length > 0 ? [...targetPaths] : [''];
  if (!disabled && rowPaths[rowPaths.length - 1].trim() !== '') {
    rowPaths.push('');
  }

  container.innerHTML = rowPaths.map((targetPath, index) => {
    const canRemove = !disabled && rowPaths.length > 1 && index < rowPaths.length - 1;
    return `
      <div class="watch-path-row" data-watch-path-row>
        <input class="watch-target-input" type="text" spellcheck="false" placeholder="/path/to/watch" value="${escapeHtml(targetPath)}" ${disabled ? 'disabled' : ''}>
        ${canRemove ? '<button class="btn-watch-path-remove" type="button" aria-label="감시 디렉터리 제거">×</button>' : ''}
      </div>
    `;
  }).join('');
}

function updateDemoControls(snapshot) {
  const actionBtn = document.getElementById('btn-demo-action');
  const resetBtn = document.getElementById('btn-demo-reset');
  const demoStatus = snapshot.demo?.status ?? 'ready';
  const isDemoWatch = snapshot.activeMode === 'demo';
  const isRunning = demoStatus === 'running';
  const isBusy = demoStatus === 'stopping';

  if (actionBtn) {
    if (isRunning) {
      actionBtn.innerText = '데모 중지';
      actionBtn.dataset.action = 'stop';
      actionBtn.disabled = false;
    } else if (isBusy) {
      actionBtn.innerText = '데모 실행 중';
      actionBtn.dataset.action = '';
      actionBtn.disabled = true;
    } else {
      actionBtn.innerText = '데모 시작';
      actionBtn.dataset.action = 'start';
      actionBtn.disabled = !isDemoWatch;
    }
  }

  if (resetBtn) {
    resetBtn.innerText = '데모 초기화';
    resetBtn.disabled = !isDemoWatch || isRunning || isBusy;
  }
}

function updateDemoSettingsControls(snapshot = {}) {
  const input = document.getElementById('demo-file-count-input');
  const saveBtn = document.getElementById('btn-demo-settings-save');
  const status = document.getElementById('demo-settings-status');
  const error = document.getElementById('demo-settings-error');
  const demoStatus = snapshot.demo?.status ?? 'ready';
  const isBusy = demoStatus === 'running' || demoStatus === 'stopping';
  const fileCount = snapshot.demoSettings?.fileCount;

  if (input && document.activeElement !== input && Number.isInteger(fileCount)) {
    input.value = String(fileCount);
  }

  if (input) {
    input.disabled = isBusy;
  }

  if (saveBtn) {
    saveBtn.disabled = isBusy;
  }

  if (status) {
    status.innerText = isBusy ? '데모 실행 중에는 변경할 수 없습니다.' : '현재 데모 설정 적용 중';
  }

  if (error) {
    error.hidden = true;
    error.innerText = '';
  }
}

function updateMonitorSettingsControls(snapshot = {}) {
  const monitor = snapshot.health?.monitor ?? snapshot.monitor ?? snapshot;
  const selectedMode = monitor.requestedBackend ?? snapshot.requestedBackend ?? 'auto';
  const activeBackend = monitor.activeBackend ?? snapshot.activeBackend ?? '-';
  const fallbackReason = monitor.fallbackReason ?? snapshot.fallbackReason;
  const pidTrackingAvailable = Boolean(monitor.pidTrackingAvailable ?? snapshot.pidTrackingAvailable);
  const status = document.getElementById('monitor-settings-status');
  const error = document.getElementById('monitor-settings-error');

  document.querySelectorAll('input[name="monitor-backend-mode"]').forEach((radio) => {
    if (document.activeElement !== radio) {
      radio.checked = radio.value === selectedMode;
    }
  });

  if (status) {
    if (fallbackReason) {
      status.innerText = formatMonitorFallbackDetails(activeBackend, fallbackReason);
    } else {
      status.innerText = `활성화: ${activeBackend}${pidTrackingAvailable ? ' / PID 추적 가능' : ''}`;
    }
  }

  if (error) {
    error.hidden = true;
    error.innerText = '';
  }
}

async function handleMonitorSettingsSave(event) {
  event.preventDefault();

  const saveBtn = document.getElementById('btn-monitor-settings-save');
  const selectedMode = document.querySelector('input[name="monitor-backend-mode"]:checked')?.value ?? 'auto';

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = '저장 중';
  }

  try {
    const response = await fetch(`${API_URL}/settings/monitor`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backendMode: selectedMode })
    });

    if (!response.ok) {
      const error = await response.json();
      showMonitorSettingsError(error.message || error.error || '감시 환경 저장 실패');
      return;
    }

    showNotification('감시 환경이 저장되었습니다.');
    await loadState();
  } catch (err) {
    console.error(err);
    showMonitorSettingsError('감시 환경 저장 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerText = '저장';
    }
  }
}

function showMonitorSettingsError(message) {
  const error = document.getElementById('monitor-settings-error');
  if (!error) return;
  error.hidden = false;
  error.innerText = message;
}

function updateResponsePolicyControls(policy = {}, context = latestSnapshot) {
  latestResponsePolicy = policy;
  const lockInput = document.getElementById('policy-lock-permissions');
  const killInput = document.getElementById('policy-kill-processes');
  const shutdownInput = document.getElementById('policy-shutdown-system');
  const scopeIncidentInput = document.getElementById('scope-incident-target');
  const scopeAllInput = document.getElementById('scope-all-watch-targets');
  const status = document.getElementById('response-policy-status');
  const error = document.getElementById('response-policy-error');

  const selectedLevel = getPolicyLevelFromPolicy(policy);
  const pidTrackingAvailable = getPidTrackingAvailable(context);
  const effectiveSelectedLevel = selectedLevel === 'kill' && !pidTrackingAvailable ? 'lock' : selectedLevel;
  const selectedScope = policy.quarantineScope === 'all-watch-targets' ? 'all-watch-targets' : 'incident-target';
  const activeElement = document.activeElement;
  if (lockInput && killInput && shutdownInput && ![lockInput, killInput, shutdownInput].includes(activeElement)) {
    lockInput.checked = effectiveSelectedLevel === 'lock';
    killInput.checked = effectiveSelectedLevel === 'kill';
    shutdownInput.checked = effectiveSelectedLevel === 'shutdown';
  }
  if (killInput) {
    killInput.disabled = !pidTrackingAvailable;
    killInput.closest('.policy-option')?.classList.toggle('disabled', !pidTrackingAvailable);
  }
  if (scopeIncidentInput && scopeAllInput && ![scopeIncidentInput, scopeAllInput].includes(activeElement)) {
    scopeIncidentInput.checked = selectedScope === 'incident-target';
    scopeAllInput.checked = selectedScope === 'all-watch-targets';
  }

  if (status) {
    status.innerText = renderPolicyStatus(policy, { pidTrackingAvailable });
  }
  if (error) {
    error.hidden = true;
    error.innerText = '';
  }
}

function renderPolicyStatus(policy = {}, { pidTrackingAvailable = true } = {}) {
  const level = getPolicyLevelFromPolicy(policy);
  const scope = policy.quarantineScope === 'all-watch-targets' ? '전체 디렉터리' : '발생 디렉터리';
  if (level === 'shutdown') return `활성화: 3단계 / ${scope}`;
  if (level === 'kill' && !pidTrackingAvailable) return `활성화: 1단계 / ${scope} (2단계는 auditd 필요)`;
  if (level === 'kill') return `활성화: 2단계 / ${scope}`;
  return `활성화: 1단계 / ${scope}`;
}

function getPolicyLevelFromPolicy(policy = {}) {
  if (policy.shutdownSystem) return 'shutdown';
  if (policy.killSuspectProcesses) return 'kill';
  return 'lock';
}

function getPolicyFromSelectedLevel(level, { pidTrackingAvailable = true } = {}) {
  const quarantineScope = document.querySelector('input[name="quarantineScope"]:checked')?.value === 'all-watch-targets'
    ? 'all-watch-targets'
    : 'incident-target';

  if (level === 'shutdown') {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: pidTrackingAvailable,
      shutdownSystem: true,
      quarantineScope
    };
  }

  if (level === 'kill' && pidTrackingAvailable) {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: true,
      shutdownSystem: false,
      quarantineScope
    };
  }

  return {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope
  };
}

function getPidTrackingAvailable(context = latestSnapshot) {
  const monitor = context?.monitor ?? context?.health?.monitor ?? context;
  return Boolean(monitor?.pidTrackingAvailable ?? context?.pidTrackingAvailable ?? context?.health?.pidTrackingAvailable);
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
      if (wCount) wCount.innerText = String(data.watchedFileCount ?? 0);
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

async function handleWatchModeChange(event) {
  const mode = event.target?.value;
  clearWatchTargetError();

  if (mode === 'demo') {
    await updateWatchTarget({ mode: 'demo' });
    return;
  }

  if (mode === 'normal') {
    await handleWatchTargetApply();
  }
}

async function handleWatchTargetApply() {
  const selectedMode = document.querySelector('input[name="watch-mode"]:checked')?.value ?? 'normal';
  const targetPaths = collectWatchTargetPaths();

  if (selectedMode !== 'normal') {
    return;
  }

  if (targetPaths.length === 0) {
    showWatchTargetError('감시할 디렉터리 경로를 입력하세요.');
    return;
  }

  await updateWatchTarget({ mode: 'normal', targetPaths });
}

async function updateWatchTarget(payload) {
  const applyBtn = document.getElementById('btn-watch-target-apply');
  if (applyBtn) applyBtn.disabled = true;

  try {
    const response = await fetch(`${API_URL}/watch/target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      clearWatchTargetError();
      showNotification(payload.mode === 'demo' ? '데모 폴더 감시로 변경되었습니다.' : '감시 디렉터리가 변경되었습니다.');
      await loadState();
      return;
    }

    const error = await response.json();
    const message = error.message === 'targetPath must be an existing directory'
      ? '존재하지 않는 디렉터리입니다.'
      : (error.message || error.error || '감시 디렉터리 변경 실패');
    showWatchTargetError(message);
  } catch (err) {
    console.error(err);
    showWatchTargetError('감시 디렉터리 변경 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (applyBtn) applyBtn.disabled = false;
  }
}

function showWatchTargetError(message) {
  const error = document.getElementById('watch-target-error');

  if (error) {
    error.hidden = false;
    error.innerText = message;
  }

  document.querySelectorAll('.watch-target-input').forEach((input) => {
    input.classList.add('invalid');
  });
}

function clearWatchTargetError() {
  const error = document.getElementById('watch-target-error');

  if (error) {
    error.hidden = true;
    error.innerText = '';
  }

  document.querySelectorAll('.watch-target-input').forEach((input) => {
    input.classList.remove('invalid');
  });
}

function collectWatchTargetPaths() {
  return [...document.querySelectorAll('.watch-target-input')]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function handleWatchTargetInput(event) {
  const input = event.target.closest('.watch-target-input');
  if (!input) return;

  clearWatchTargetError();
  const inputs = [...document.querySelectorAll('.watch-target-input')];
  const isLastInput = inputs[inputs.length - 1] === input;
  if (isLastInput && input.value.trim() !== '') {
    const row = input.closest('[data-watch-path-row]');
    if (row && !row.querySelector('.btn-watch-path-remove')) {
      row.insertAdjacentHTML('beforeend', '<button class="btn-watch-path-remove" type="button" aria-label="감시 디렉터리 제거">×</button>');
    }
    document.getElementById('watch-target-list')?.insertAdjacentHTML('beforeend', `
      <div class="watch-path-row" data-watch-path-row>
        <input class="watch-target-input" type="text" spellcheck="false" placeholder="/path/to/watch">
      </div>
    `);
  }
}

function handleWatchPathRemove(event) {
  const btn = event.target.closest('.btn-watch-path-remove');
  if (!btn) return;

  const row = btn.closest('[data-watch-path-row]');
  row?.remove();
  clearWatchTargetError();
}


async function handleDemoAction() {
  const btn = document.getElementById('btn-demo-action');
  const action = btn?.dataset.action;
  if (!btn || !action) return;

  if (btn) {
    btn.disabled = true;
    btn.innerText = '데모 실행 중';
  }

  try {
    const response = await fetch(`${API_URL}/demo/${action === 'stop' ? 'stop' : 'start'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      showNotification(action === 'stop' ? '데모 중지 요청됨' : '데모 시작됨');
      await loadState();
    } else {
      const error = await response.json();
      alert(`데모 요청 실패: ${error.message || error.error || '알 수 없는 오류'}`);
    }
  } catch (err) {
    console.error(err);
    alert('데모 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    await loadState();
  }
}

async function handleDemoReset() {
  const btn = document.getElementById('btn-demo-reset');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '초기화 중...';
  }

  try {
    const response = await fetch(`${API_URL}/demo/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      latestRuleWeight = null;
      updateRuleWeightDisplay({ currentWeight: 0, thresholdWeight: detectionPolicyDraft.thresholdWeight });
      showNotification('데모 폴더, Incident 관리 항목, 현재 가중치가 초기화되었습니다.');
      await loadState();
    } else {
      const error = await response.json();
      alert(`데모 초기화 실패: ${error.message || error.error || '알 수 없는 오류'}`);
    }
  } catch (err) {
    console.error(err);
    alert('데모 초기화 요청 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (btn) {
      btn.disabled = false;
    }
    await loadState();
  }
}

async function handleDemoSettingsSave(event) {
  event.preventDefault();

  const input = document.getElementById('demo-file-count-input');
  const saveBtn = document.getElementById('btn-demo-settings-save');
  const fileCount = Number(input?.value);

  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 200) {
    showDemoSettingsError('데모 파일 개수는 1부터 200 사이의 정수여야 합니다.');
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = '저장 중';
  }

  try {
    const response = await fetch(`${API_URL}/settings/demo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileCount })
    });

    if (!response.ok) {
      const error = await response.json();
      showDemoSettingsError(error.message || error.error || '데모 설정 저장 실패');
      return;
    }

    const settings = await response.json();
    updateDemoSettingsControls({ demoSettings: settings, demo: { status: 'ready' } });
    showNotification('데모 설정이 저장되었습니다.');
    await loadState();
  } catch (err) {
    console.error(err);
    showDemoSettingsError('데모 설정 저장 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerText = '저장';
    }
  }
}

function showDemoSettingsError(message) {
  const error = document.getElementById('demo-settings-error');
  if (!error) return;
  error.hidden = false;
  error.innerText = message;
}

async function handleResponsePolicySave(event) {
  event.preventDefault();

  const saveBtn = document.getElementById('btn-response-policy-save');
  const selectedLevel = document.querySelector('input[name="responsePolicyLevel"]:checked')?.value ?? 'lock';
  const pidTrackingAvailable = getPidTrackingAvailable();

  if (selectedLevel === 'kill' && !pidTrackingAvailable) {
    updateResponsePolicyControls(latestResponsePolicy ?? {}, latestSnapshot);
    showResponsePolicyError('2단계 대응은 auditd PID 추적이 가능할 때만 사용할 수 있습니다.');
    return;
  }

  const payload = getPolicyFromSelectedLevel(selectedLevel, { pidTrackingAvailable });

  if (payload.shutdownSystem && !confirm('OS 강제 종료 단계가 활성화됩니다. 격리 VM 또는 실습 환경에서만 사용하세요.')) {
    return;
  }

  if (payload.killSuspectProcesses && !confirm('의심 프로세스 종료 단계가 활성화됩니다. 감시 디렉토리를 점유 중인 프로세스만 대상으로 합니다.')) {
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = '저장 중';
  }

  try {
    const response = await fetch(`${API_URL}/settings/response-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      showResponsePolicyError(error.message || error.error || '대응 정책 저장 실패');
      return;
    }

    const policy = await response.json();
    updateResponsePolicyControls(policy, latestSnapshot);
    showNotification('대응 정책이 저장되었습니다.');
    await loadState();
  } catch (err) {
    console.error(err);
    showResponsePolicyError('대응 정책 저장 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerText = '저장';
    }
  }
}

async function handleQuarantineScopeChange() {
  const selectedLevel = document.querySelector('input[name="responsePolicyLevel"]:checked')?.value ?? 'lock';
  const payload = getPolicyFromSelectedLevel(selectedLevel);

  try {
    const response = await fetch(`${API_URL}/settings/response-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      showDetectionPolicyError(error.message || error.error || '격리 범위 저장 실패');
      return;
    }

    const policy = await response.json();
    updateResponsePolicyControls(policy);
    showNotification('격리 범위가 저장되었습니다.');
  } catch (err) {
    console.error(err);
    showDetectionPolicyError('격리 범위 저장 중 네트워크 오류가 발생했습니다.');
  }
}

function showResponsePolicyError(message) {
  const error = document.getElementById('response-policy-error');
  if (!error) return;
  error.hidden = false;
  error.innerText = message;
}

function updateDetectionPolicyControls(policy = {}) {
  detectionPolicyDraft = normalizeClientDetectionPolicy(policy);

  document.querySelectorAll('[data-policy-path]').forEach((input) => {
    const value = getPolicyPathValue(detectionPolicyDraft, input.dataset.policyPath);
    if (document.activeElement !== input) {
      input.value = String(value);
    }
    updateDetectionPolicyNumberInput(input.dataset.policyPath, value);
  });

  renderAllowedExtensionList();

  const status = document.getElementById('detection-policy-status');
  if (status) {
    status.innerText = '현재 규칙 적용 중';
  }

  clearDetectionPolicyError();
}

function normalizeClientDetectionPolicy(policy = {}) {
  const source = policy && typeof policy === 'object' ? policy : {};

  return {
    thresholdWeight: readPolicyNumber(source.thresholdWeight, DEFAULT_DETECTION_POLICY.thresholdWeight),
    weights: {
      knownExtension: readPolicyNumber(source.weights?.knownExtension, DEFAULT_DETECTION_POLICY.weights.knownExtension),
      unknownExtension: readPolicyNumber(source.weights?.unknownExtension, DEFAULT_DETECTION_POLICY.weights.unknownExtension),
      noExtension: readPolicyNumber(source.weights?.noExtension, DEFAULT_DETECTION_POLICY.weights.noExtension),
      suspiciousExtension: readPolicyNumber(source.weights?.suspiciousExtension, DEFAULT_DETECTION_POLICY.weights.suspiciousExtension)
    },
    eventMultipliers: {
      create: readPolicyNumber(source.eventMultipliers?.create, DEFAULT_DETECTION_POLICY.eventMultipliers.create),
      modify: readPolicyNumber(source.eventMultipliers?.modify, DEFAULT_DETECTION_POLICY.eventMultipliers.modify),
      rename: readPolicyNumber(source.eventMultipliers?.rename, DEFAULT_DETECTION_POLICY.eventMultipliers.rename)
    },
    weightDecay: {
      intervalMs: readPolicyNumber(source.weightDecay?.intervalMs, DEFAULT_DETECTION_POLICY.weightDecay.intervalMs),
      amount: readPolicyNumber(source.weightDecay?.amount, DEFAULT_DETECTION_POLICY.weightDecay.amount)
    },
    userAllowedExtensions: normalizeClientExtensionList(source.userAllowedExtensions),
    suspiciousExtensions: normalizeClientExtensionList(
      source.suspiciousExtensions,
      DEFAULT_DETECTION_POLICY.suspiciousExtensions
    )
  };
}

function readPolicyNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeClientExtensionList(rawExtensions, fallback = []) {
  const source = Array.isArray(rawExtensions) ? rawExtensions : fallback;
  const seen = new Set();
  const extensions = [];

  for (const extension of source) {
    const normalized = normalizeClientExtension(extension);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      extensions.push(normalized);
    }
  }

  return extensions;
}

function normalizeClientExtension(extension) {
  const value = String(extension ?? '').trim();
  if (!value) return '';
  return value.startsWith('.') ? value.slice(1).toLowerCase() : value.toLowerCase();
}

function cloneDetectionPolicy(policy) {
  return {
    thresholdWeight: policy.thresholdWeight,
    weights: { ...policy.weights },
    eventMultipliers: { ...policy.eventMultipliers },
    weightDecay: { ...policy.weightDecay },
    userAllowedExtensions: [...policy.userAllowedExtensions],
    suspiciousExtensions: [...policy.suspiciousExtensions]
  };
}

function getPolicyPathValue(policy, policyPath) {
  if (!policyPath.includes('.')) {
    return policy?.[policyPath] ?? 0;
  }
  const [group, key] = policyPath.split('.');
  return policy?.[group]?.[key] ?? 0;
}

function setPolicyPathValue(policy, policyPath, value) {
  if (!policyPath.includes('.')) {
    policy[policyPath] = value;
    return;
  }
  const [group, key] = policyPath.split('.');
  if (!policy[group]) {
    policy[group] = {};
  }
  policy[group][key] = value;
}

function updateDetectionPolicyNumberInput(policyPath, value) {
  const input = document.querySelector(`[data-policy-number="${policyPath}"]`);
  if (input && document.activeElement !== input) {
    input.value = formatPolicyNumber(value);
  }
}

function handleDetectionPolicyRangeInput(event) {
  const input = event.target.closest('[data-policy-path]');
  if (!input) return;

  const value = Number(input.value);
  if (!Number.isFinite(value)) return;

  setPolicyPathValue(detectionPolicyDraft, input.dataset.policyPath, value);
  updateDetectionPolicyNumberInput(input.dataset.policyPath, value);
}

function handleDetectionPolicyNumberInput(event) {
  const input = event.target.closest('[data-policy-number]');
  if (!input) return;

  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return;

  const range = document.querySelector(`[data-policy-path="${input.dataset.policyNumber}"]`);
  const max = Number(input.max);
  const boundedValue = Number.isFinite(max) ? Math.min(value, max) : value;

  setPolicyPathValue(detectionPolicyDraft, input.dataset.policyNumber, boundedValue);
  if (range) {
    range.value = String(boundedValue);
  }
}

function handleDetectionPolicyNumberChange(event) {
  const input = event.target.closest('[data-policy-number]');
  if (!input) return;

  const currentValue = getPolicyPathValue(detectionPolicyDraft, input.dataset.policyNumber);
  input.value = formatPolicyNumber(currentValue);
}

function formatPolicyNumber(value) {
  return Number(value).toFixed(2);
}

function handleAllowedExtensionAdd() {
  const input = document.getElementById('allowed-extension-input');
  const normalized = normalizeClientExtension(input?.value);

  if (!normalized) {
    showDetectionPolicyError('추가할 확장자를 입력하세요.');
    return;
  }

  if (!detectionPolicyDraft.userAllowedExtensions.includes(normalized)) {
    detectionPolicyDraft.userAllowedExtensions.push(normalized);
  }

  if (input) {
    input.value = '';
  }

  clearDetectionPolicyError();
  renderAllowedExtensionList();
}

function renderAllowedExtensionList() {
  const container = document.getElementById('allowed-extension-list');
  if (!container) return;

  const extensions = detectionPolicyDraft.userAllowedExtensions;
  if (extensions.length === 0) {
    container.innerHTML = '<span class="empty-chip">추가된 확장자가 없습니다.</span>';
    return;
  }

  container.innerHTML = extensions.map((extension) => `
    <span class="extension-chip">
      .${escapeHtml(extension)}
      <button type="button" aria-label="${escapeHtml(extension)} 제거" data-extension-remove="${escapeHtml(extension)}">×</button>
    </span>
  `).join('');
}

function handleAllowedExtensionRemove(event) {
  const btn = event.target.closest('[data-extension-remove]');
  if (!btn) return;

  detectionPolicyDraft.userAllowedExtensions = detectionPolicyDraft.userAllowedExtensions
    .filter((extension) => extension !== btn.dataset.extensionRemove);
  renderAllowedExtensionList();
}

async function handleDetectionPolicySave(event) {
  event.preventDefault();

  const saveBtn = document.getElementById('btn-detection-policy-save');
  const payload = cloneDetectionPolicy(detectionPolicyDraft);

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = '저장 중';
  }

  try {
    const response = await fetch(`${API_URL}/settings/detection-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      showDetectionPolicyError(error.message || error.error || '탐지 규칙 저장 실패');
      return;
    }

    const policy = await response.json();
    updateDetectionPolicyControls(policy);
    showNotification('탐지 규칙이 저장되었습니다.');
  } catch (err) {
    console.error(err);
    showDetectionPolicyError('탐지 규칙 저장 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerText = '저장';
    }
  }
}

async function handleDetectionPolicyReset() {
  const resetBtn = document.getElementById('btn-detection-policy-reset');

  if (!confirm('가중치와 사용자 화이트리스트 확장자를 기본값으로 초기화할까요?')) {
    return;
  }

  if (resetBtn) {
    resetBtn.disabled = true;
    resetBtn.innerText = '초기화 중';
  }

  try {
    const response = await fetch(`${API_URL}/settings/detection-policy/reset`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json();
      showDetectionPolicyError(error.message || error.error || '탐지 규칙 초기화 실패');
      return;
    }

    const policy = await response.json();
    updateDetectionPolicyControls(policy);
    showNotification('탐지 규칙이 기본값으로 초기화되었습니다.');
  } catch (err) {
    console.error(err);
    showDetectionPolicyError('탐지 규칙 초기화 중 네트워크 오류가 발생했습니다.');
  } finally {
    if (resetBtn) {
      resetBtn.disabled = false;
      resetBtn.innerText = '가중치 초기화';
    }
  }
}

function showDetectionPolicyError(message) {
  const error = document.getElementById('detection-policy-error');
  if (!error) return;
  error.hidden = false;
  error.innerText = message;
}

function clearDetectionPolicyError() {
  const error = document.getElementById('detection-policy-error');
  if (!error) return;
  error.hidden = true;
  error.innerText = '';
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
    const pathLabel = formatRootPaths(job.rootPaths, job.rootPath);
    const pathTitle = Array.isArray(job.rootPaths) && job.rootPaths.length > 0
      ? job.rootPaths.join('\n')
      : (job.rootPath ?? '');
    return `
    <tr>
      <td>${escapeHtml(job.incidentId.substring(0, 8))}...</td>
      <td class="path-cell" title="${escapeHtml(pathTitle)}">${escapeHtml(pathLabel)}</td>
      <td title="권한 레코드 ${Number(job.permissionEntryCount) || Number(job.entryCount) || 0}개">${Number(job.entryCount) || 0}개</td>
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
    restored: '권한 복구됨'
  };
  return labels[status] ?? status;
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
    case 'demo':
      html = renderDemoEntry(entry);
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
  const weight = takeRuleWeight(payload);
  return {
    _type: 'file',
    eventType: payload.type ?? 'event',
    path: payload.path,
    pid: payload.pid,
    comm: payload.comm,
    exe: payload.exe,
    source: payload.source,
    observedAt: payload.observedAt ?? new Date().toISOString(),
    weight
  };
}

function cacheRuleWeight(payload = {}) {
  if (!payload.path) return;
  pendingRuleWeightsByPath.set(String(payload.path), normalizeRuleWeight(payload));
  while (pendingRuleWeightsByPath.size > 200) {
    const firstKey = pendingRuleWeightsByPath.keys().next().value;
    pendingRuleWeightsByPath.delete(firstKey);
  }
}

function takeRuleWeight(payload = {}) {
  if (!payload.path) return null;
  const key = String(payload.path);
  const weight = pendingRuleWeightsByPath.get(key) ?? null;
  pendingRuleWeightsByPath.delete(key);
  return weight;
}

function normalizeRuleWeight(payload = {}) {
  return {
    currentWeight: readPolicyNumber(payload.currentWeight, 0),
    thresholdWeight: readPolicyNumber(payload.thresholdWeight, DEFAULT_DETECTION_POLICY.thresholdWeight),
    eventWeight: readPolicyNumber(payload.eventWeight, 0),
    eventCount: Number.isFinite(payload.eventCount) ? payload.eventCount : 0
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
        totalWeight: payload.totalWeight,
        thresholdWeight: payload.thresholdWeight,
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
        rootPaths: payload.rootPaths ?? [],
        entryCount: payload.entryCount,
        reason: payload.reason,
        observedAt: payload.observedAt ?? new Date().toISOString()
      };
    case 'RESTORE_COMPLETED':
      return {
        _type: 'restore',
        incidentId: payload.incidentId,
        rootPath: payload.rootPath,
        rootPaths: payload.rootPaths ?? [],
        observedAt: payload.observedAt ?? new Date().toISOString()
      };
    case 'DEMO_STARTED':
    case 'DEMO_ABORTED':
    case 'DEMO_COMPLETED':
      return {
        _type: 'demo',
        status: payload.status ?? msg.type.replace('DEMO_', '').toLowerCase(),
        reason: payload.lastError,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        observedAt: payload.completedAt ?? payload.startedAt ?? new Date().toISOString()
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
        <span class="severity success">복원 완료</span>
        <span class="log-type">권한 복원</span>
      </div>
      <div class="log-reason">ID: ${escapeHtml(entry.incidentId ?? '-')}</div>
    </div>
  `;
}

function renderDemoEntry(entry) {
  const time = formatTime(entry.observedAt);
  const statusLabel = getDemoStatusLabel(entry.status);
  const severityClass = entry.status === 'completed' ? 'success' : entry.status === 'failed' ? 'error' : 'low';

  return `
    <div class="log-entry alert-demo">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${severityClass}">${escapeHtml(statusLabel)}</span>
        <span class="log-type">데모</span>
        ${renderPermissionErrorBadge(entry)}
      </div>
      ${entry.reason ? `<div class="log-reason">${escapeHtml(entry.reason)}</div>` : ''}
    </div>
  `;
}

function renderAlertEntry(alert) {
  const time = formatTime(alert.observedAt);
  const type = alert.ruleId ? 'rule_match' : (alert.eventType ?? 'match');
  const typeClass = `alert-${String(type).toLowerCase().replace(/_/g, '-')}`;
  const severity = String(alert.severity ?? 'high').toLowerCase();

  return `
    <div class="log-entry ${typeClass}">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${escapeHtml(severity)}">${escapeHtml(getSeverityLabel(severity))}</span>
        <span class="log-type">${escapeHtml(getIncidentTypeLabel(type))}</span>
        ${renderPermissionErrorBadge(alert)}
        ${alert.ruleName ? `<span class="log-rule">${escapeHtml(alert.ruleName)}</span>` : ''}
      </div>
      ${alert.samplePaths?.length ? renderFileChips(extractFileNames(alert.samplePaths)) : ''}
      ${renderWeightLine(alert)}
      ${alert.reason ? `<div class="log-reason">${escapeHtml(alert.reason)}</div>` : ''}
    </div>
  `;
}

function renderQuarantineEntry(entry) {
  const time = formatTime(entry.observedAt);
  const statusLabel = getQuarantineStatusLabel(entry.status);
  const severityClass = entry.status === 'completed' ? 'success' : entry.status === 'failed' ? 'error' : 'low';
  const pathLabel = formatRootPaths(entry.rootPaths, entry.rootPath);

  return `
    <div class="log-entry alert-quarantine">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="severity ${severityClass}">${escapeHtml(statusLabel)}</span>
        <span class="log-type">격리</span>
        ${renderPermissionErrorBadge(entry)}
      </div>
      <div class="log-path">${escapeHtml(pathLabel)}</div>
      <div class="log-reason">ID: ${escapeHtml(entry.incidentId ?? '-')} · ${Number(entry.entryCount) || 0}개 항목</div>
      ${entry.reason ? `<div class="log-reason">${escapeHtml(entry.reason)}</div>` : ''}
    </div>
  `;
}

function renderPermissionErrorBadge(entry = {}) {
  if (!hasPermissionError(entry)) {
    return '';
  }

  return '<span class="permission-error-tag">Permission denied</span>';
}

function hasPermissionError(entry = {}) {
  const values = [
    entry.reason,
    entry.errorCode,
    entry.errorMessage,
    entry.lastError,
    entry.blocked?.reason,
    entry.blocked?.errorCode,
    entry.blocked?.errorMessage
  ];

  return values.some((value) => /(?:\bEACCES\b|\bEPERM\b|permission denied)/i.test(String(value ?? '')));
}


function getQuarantineStatusLabel(status) {
  const labels = {
    started: '격리 시작',
    completed: '격리 완료',
    failed: '격리 실패',
    quarantining: '격리 중',
    quarantined: '격리됨'
  };
  return labels[status] ?? '격리 상태';
}

function getDemoStatusLabel(status) {
  const labels = {
    started: '데모 시작',
    running: '데모 실행 중',
    stopping: '데모 중지 중',
    aborted: '데모 중단',
    completed: '데모 완료',
    failed: '데모 실패',
    ready: '데모 대기'
  };
  return labels[status] ?? '데모 상태';
}

function getSeverityLabel(severity) {
  const labels = {
    critical: '심각',
    high: '높음',
    medium: '보통',
    low: '낮음',
    success: '성공',
    error: '오류'
  };
  return labels[severity] ?? severity;
}

function getIncidentTypeLabel(type) {
  const labels = {
    rule_match: '탐지',
    create: '생성 탐지',
    modify: '변경 탐지',
    delete: '삭제 탐지',
    rename: '이름 변경 탐지',
    match: '탐지'
  };
  return labels[String(type).toLowerCase()] ?? '탐지';
}

function formatRootPaths(rootPaths = [], fallback = '-') {
  const paths = Array.isArray(rootPaths) && rootPaths.length > 0 ? rootPaths : [fallback].filter(Boolean);
  if (paths.length <= 1) {
    return paths[0] ?? '-';
  }

  return `${paths[0]} 외 ${paths.length - 1}개`;
}

function renderFileEventEntry(entry) {
  const time = formatTime(entry.observedAt);
  const type = String(entry.eventType ?? 'event').toUpperCase();
  const typeClass = `file-${type.toLowerCase()}`;
  return `
    <div class="log-entry ${escapeHtml(typeClass)}">
      <div class="log-meta">
        <span class="log-time">${time}</span>
        <span class="log-type">${escapeHtml(type)}</span>
      </div>
      <div class="log-path">${escapeHtml(entry.path ?? '')}</div>
      ${renderProcessLine(entry)}
      ${entry.weight ? renderFsEventWeightValue(entry.weight) : ''}
    </div>
  `;
}

function renderProcessLine(entry) {
  if (entry.pid === undefined || entry.pid === null || entry.pid === '') {
    return '';
  }

  const details = [
    `PID ${entry.pid}`,
    entry.comm ? `comm ${entry.comm}` : '',
    entry.exe ? `exe ${entry.exe}` : ''
  ].filter(Boolean).join(' / ');

  return `<div class="log-reason">${escapeHtml(details)}</div>`;
}

function updateRuleWeightDisplay(payload = {}) {
  const weight = normalizeRuleWeight(payload);
  const current = Math.max(0, weight.currentWeight);
  const threshold = weight.thresholdWeight > 0
    ? weight.thresholdWeight
    : DEFAULT_DETECTION_POLICY.thresholdWeight;
  const label = document.getElementById('current-weight');
  const bar = document.getElementById('current-weight-bar');
  const percent = Math.min(100, (current / threshold) * 100);

  if (label) {
    label.innerText = `${formatPolicyNumber(current)} / ${formatPolicyNumber(threshold)}`;
  }
  if (bar) {
    bar.style.width = `${percent}%`;
    bar.classList.toggle('over-threshold', current > threshold);
  }
}

function renderFsEventWeightValue(weight) {
  return `<span class="fs-weight-value">${formatPolicyNumber(weight.currentWeight)}</span>`;
}

function renderWeightLine(alert) {
  if (!Number.isFinite(alert.totalWeight) || !Number.isFinite(alert.thresholdWeight)) {
    return '';
  }

  return `<div class="log-reason">누적 가중치: ${formatPolicyNumber(alert.totalWeight)} / ${formatPolicyNumber(alert.thresholdWeight)}</div>`;
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
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
    if (text && text.innerText === '메인 서버 연결 중...') {
      setServerStatus('online', '메인 서버 연결됨 (감시 및 격리)');
    }
  } catch {
    setServerStatus('offline', '메인 서버 연결 끊김');
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


document.getElementById('btn-demo-action')?.addEventListener('click', handleDemoAction);
document.getElementById('btn-demo-reset')?.addEventListener('click', handleDemoReset);
document.getElementById('btn-watch-toggle')?.addEventListener('click', handleWatchToggle);
document.getElementById('btn-watch-target-apply')?.addEventListener('click', handleWatchTargetApply);
document.getElementById('watch-target-list')?.addEventListener('input', handleWatchTargetInput);
document.getElementById('watch-target-list')?.addEventListener('click', handleWatchPathRemove);
document.getElementById('response-policy-form')?.addEventListener('submit', handleResponsePolicySave);
document.getElementById('demo-settings-form')?.addEventListener('submit', handleDemoSettingsSave);
document.getElementById('monitor-settings-form')?.addEventListener('submit', handleMonitorSettingsSave);
document.getElementById('detection-policy-form')?.addEventListener('submit', handleDetectionPolicySave);
document.getElementById('detection-policy-form')?.addEventListener('input', handleDetectionPolicyRangeInput);
document.getElementById('detection-policy-form')?.addEventListener('input', handleDetectionPolicyNumberInput);
document.getElementById('detection-policy-form')?.addEventListener('change', handleDetectionPolicyNumberChange);
document.getElementById('btn-detection-policy-reset')?.addEventListener('click', handleDetectionPolicyReset);
document.getElementById('btn-allowed-extension-add')?.addEventListener('click', handleAllowedExtensionAdd);
document.getElementById('allowed-extension-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleAllowedExtensionAdd();
  }
});
document.getElementById('allowed-extension-list')?.addEventListener('click', handleAllowedExtensionRemove);
document.querySelectorAll('input[name="quarantineScope"]').forEach((radio) => {
  radio.addEventListener('change', handleQuarantineScopeChange);
});
document.querySelectorAll('input[name="dashboard-theme"]').forEach((radio) => {
  radio.addEventListener('change', handleThemeChange);
});
document.querySelectorAll('input[name="watch-mode"]').forEach((radio) => {
  radio.addEventListener('change', handleWatchModeChange);
});

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
applyTheme(loadThemePreference());
checkHealth();
setInterval(checkHealth, 5000);
