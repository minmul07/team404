import fs from 'node:fs';
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEventBus } from '../shared/utils/create-event-bus.js';
import { MonitorService } from '../collector/monitor-service.js';
import { IncidentStore } from '../incidents/incident-store.js';
import { RuleEngine } from '../rules/rule-engine.js';
import { QuarantineService } from '../isolation/quarantine-service.js';
import { normalizeDemoFileCount, resetDemo } from '../simulator/demo.js';
import { EVENT_NAMES } from '../shared/contracts/event-names.js';
import { getDefaultDetectionPolicy, normalizeDetectionPolicy } from '../shared/config/detection-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_WORKER_PATH = path.resolve(__dirname, '../simulator/demo-worker.js');
const DEMO_STOP_TIMEOUT_MS = 1500;

export const DEFAULT_RESPONSE_POLICY = Object.freeze({
  lockDirectoryPermissions: true,
  killSuspectProcesses: false,
  shutdownSystem: false
});

export function createRuntime(config, options = {}) {
  const eventBus = createEventBus();
  const incidentStore = new IncidentStore({ eventBus });
  const ruleEngine = new RuleEngine({ eventBus, config });
  const responsePolicy = normalizeResponsePolicy(
    options.responsePolicy ?? config.responsePolicy
  );
  const detectionPolicy = normalizeDetectionPolicy(
    options.detectionPolicy ?? config.detectionPolicy
  );
  const quarantineService = new QuarantineService({
    eventBus,
    getResponsePolicy: () => ({ ...responsePolicy })
  });
  const monitorService = new MonitorService({
    config,
    eventBus,
    watchOptions: options.watchOptions ?? options.watch ?? {}
  });
  const demoProcessFactory = options.demoProcessFactory ?? startDemoWorker;

  const state = {
    startedAt: null,
    stoppedAt: null,
    watchEnabled: true,
    lastFsEventAt: null,
    lastRuleMatchAt: null,
    demo: {
      status: 'ready',
      startedAt: null,
      completedAt: null,
      lastError: null,
      worker: null,
      workerPid: null,
      runAsUid: null,
      runAsGid: null,
      privilegeWarning: null,
      blocked: null,
      stopTimer: null
    }
  };

  eventBus.on('fs_event', (event) => {
    state.lastFsEventAt = event.observedAt;
  });

  eventBus.on('rule_match', (match) => {
    state.lastRuleMatchAt = match.observedAt;
  });

  return {
    config,
    eventBus,
    incidentStore,
    monitorService,
    ruleEngine,
    async start() {
      state.startedAt = new Date().toISOString();
      state.stoppedAt = null;
      await monitorService.start();
    },
    async stop() {
      stopDemoWorkerForShutdown(state);
      await monitorService.stop();
      ruleEngine.stop();
      quarantineService.stop();
      incidentStore.stop();
      state.stoppedAt = new Date().toISOString();
    },
    async stopWatch() {
      if (!state.watchEnabled) {
        return this.getSnapshot();
      }

      await monitorService.stop();
      state.watchEnabled = false;
      return this.getSnapshot();
    },
    async startWatch() {
      if (state.watchEnabled) {
        return this.getSnapshot();
      }

      await monitorService.start();
      state.watchEnabled = true;
      return this.getSnapshot();
    },
    isWatchEnabled() {
      return state.watchEnabled;
    },
    async enableDemoMode() {
      await monitorService.setWatchOptions({ demo: true });
      return this.getSnapshot();
    },
    async disableDemoMode() {
      await monitorService.setWatchOptions();
      return this.getSnapshot();
    },
    async setTargetPath(targetPath) {
      await monitorService.setWatchOptions({ targetPath });
      return this.getSnapshot();
    },
    getResponsePolicy() {
      return { ...responsePolicy };
    },
    getDetectionPolicy() {
      return cloneDetectionPolicy(detectionPolicy);
    },
    updateResponsePolicy(nextPolicy = {}) {
      const normalizedPolicy = normalizeResponsePolicy(nextPolicy);
      responsePolicy.lockDirectoryPermissions = normalizedPolicy.lockDirectoryPermissions;
      responsePolicy.killSuspectProcesses = normalizedPolicy.killSuspectProcesses;
      responsePolicy.shutdownSystem = normalizedPolicy.shutdownSystem;
      return this.getResponsePolicy();
    },
    async updateDetectionPolicy(nextPolicy = {}) {
      const normalizedPolicy = normalizeDetectionPolicy(nextPolicy);
      applyDetectionPolicy(detectionPolicy, normalizedPolicy);
      config.detectionPolicy = cloneDetectionPolicy(detectionPolicy);
      ruleEngine.updateDetectionPolicy(config.detectionPolicy);
      await persistConfigSection(config.meta?.configPath, 'detectionPolicy', config.detectionPolicy);
      return this.getDetectionPolicy();
    },
    async resetDetectionPolicy() {
      return this.updateDetectionPolicy(getDefaultDetectionPolicy());
    },
    getDemoSettings() {
      return {
        fileCount: normalizeDemoFileCount(config.demo?.fileCount)
      };
    },
    async updateDemoSettings(nextSettings = {}) {
      if (state.demo.status === 'running' || state.demo.status === 'stopping') {
        throw createRuntimeError('Demo settings cannot be changed while demo is running', 409);
      }

      config.demo = {
        ...config.demo,
        fileCount: normalizeDemoFileCount(nextSettings.fileCount)
      };
      await persistConfigSection(config.meta?.configPath, 'demo', config.demo);
      return this.getDemoSettings();
    },
    async startDemo() {
      const monitorHealth = monitorService.getHealth();

      if (monitorHealth.activeMode !== 'demo') {
        throw createRuntimeError('Demo can start only while demo folder watch is selected', 409);
      }

      if (state.demo.status === 'running' || state.demo.status === 'stopping') {
        return this.getSnapshot();
      }

      const target = monitorHealth.activeTarget;
      const identity = resolveDemoRunIdentity(config);
      let worker;

      try {
        resetDemo({
          ownerUid: identity.runAsUid,
          ownerGid: identity.runAsGid,
          fileCount: this.getDemoSettings().fileCount
        });
        worker = demoProcessFactory({
          cwd: config.meta?.projectRoot ?? process.cwd(),
          uid: identity.forkUid,
          gid: identity.forkGid,
          fileCount: this.getDemoSettings().fileCount
        });
      } catch (error) {
        state.demo = {
          status: 'failed',
          startedAt: null,
          completedAt: new Date().toISOString(),
          lastError: error.message,
          worker: null,
          workerPid: null,
          runAsUid: identity.runAsUid,
          runAsGid: identity.runAsGid,
          privilegeWarning: identity.privilegeWarning,
          blocked: null,
          stopTimer: null
        };
        eventBus.emit(EVENT_NAMES.DEMO_ABORTED, toDemoSnapshot(state.demo));
        throw error;
      }

      state.demo = {
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        worker,
        workerPid: worker.pid ?? null,
        runAsUid: identity.runAsUid,
        runAsGid: identity.runAsGid,
        privilegeWarning: identity.privilegeWarning,
        blocked: null,
        stopTimer: null
      };
      eventBus.emit(EVENT_NAMES.DEMO_STARTED, toDemoSnapshot(state.demo));

      worker.on('message', (message) => {
        handleDemoWorkerMessage({
          message,
          state,
          eventBus,
          target,
          worker
        });
      });

      worker.once('error', (error) => {
        if (state.demo.worker !== worker) {
          return;
        }

        finishDemoWorker({
          state,
          eventBus,
          status: 'failed',
          lastError: error.message,
          worker
        });
      });

      worker.once('exit', (code, signal) => {
        if (state.demo.worker !== worker) {
          return;
        }

        const wasStopping = state.demo.status === 'stopping';
        finishDemoWorker({
          state,
          eventBus,
          status: wasStopping ? 'aborted' : 'failed',
          lastError: wasStopping
            ? null
            : `Demo worker exited before completion (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
          worker
        });
      });

      worker.stderr?.on?.('data', (chunk) => {
        const message = String(chunk).trim();
        if (message) {
          state.demo.lastError = message;
        }
      });

      return this.getSnapshot();
    },
    async stopDemo() {
      if (state.demo.status !== 'running' || !state.demo.worker) {
        return this.getSnapshot();
      }

      state.demo.status = 'stopping';
      sendDemoWorkerMessage(state.demo.worker, { type: 'abort' });
      state.demo.stopTimer = setTimeout(() => {
        if (state.demo.worker) {
          state.demo.worker.kill('SIGTERM');
        }
      }, DEMO_STOP_TIMEOUT_MS);
      return this.getSnapshot();
    },
    async resetDemo() {
      if (state.demo.status === 'running' || state.demo.status === 'stopping') {
        throw createRuntimeError('Demo reset is not available while demo is running', 409);
      }

      const identity = resolveDemoRunIdentity(config);
      resetDemo({
        ownerUid: identity.runAsUid,
        ownerGid: identity.runAsGid,
        fileCount: this.getDemoSettings().fileCount
      });
      incidentStore.clear();
      quarantineService.clearRecords();
      state.demo = {
        status: 'ready',
        startedAt: null,
        completedAt: null,
        lastError: null,
        worker: null,
        workerPid: null,
        runAsUid: identity.runAsUid,
        runAsGid: identity.runAsGid,
        privilegeWarning: identity.privilegeWarning,
        blocked: null,
        stopTimer: null
      };
      return this.getSnapshot();
    },
    getHealth() {
      const now = Date.now();
      const startedAtTs = state.startedAt ? Date.parse(state.startedAt) : null;
      const monitorHealth = monitorService.getHealth();

      return {
        status: monitorHealth.status,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        uptimeMs: startedAtTs ? now - startedAtTs : 0,
        lastFsEventAt: state.lastFsEventAt,
        lastRuleMatchAt: state.lastRuleMatchAt,
        watchEnabled: state.watchEnabled,
        activeMode: monitorHealth.activeMode,
        activeTarget: monitorHealth.activeTarget,
        responsePolicy: this.getResponsePolicy(),
        detectionPolicy: this.getDetectionPolicy(),
        demoSettings: this.getDemoSettings(),
        demo: toDemoSnapshot(state.demo),
        monitor: monitorHealth,
        rules: ruleEngine.getState(),
        incidents: incidentStore.getSummary()
      };
    },
    getSnapshot() {
      const monitorHealth = monitorService.getHealth();
      const watchedFileCount = countFiles(monitorHealth.activeTarget?.rootPath);
      return {
        health: this.getHealth(),
        watchEnabled: state.watchEnabled,
        activeMode: monitorHealth.activeMode,
        activeTarget: monitorHealth.activeTarget,
        responsePolicy: this.getResponsePolicy(),
        detectionPolicy: this.getDetectionPolicy(),
        demoSettings: this.getDemoSettings(),
        demo: toDemoSnapshot(state.demo),
        watchedFileCount,
        incidents: incidentStore.getIncidents(),
        alerts: incidentStore.getAlerts(),
        quarantineJobs: incidentStore.getQuarantineJobs()
      };
    },
    async restoreIncident(incidentId) {
      return quarantineService.restore(incidentId);
    }
  };
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

function applyDetectionPolicy(target, source) {
  target.thresholdWeight = source.thresholdWeight;
  target.weights = { ...source.weights };
  target.eventMultipliers = { ...source.eventMultipliers };
  target.weightDecay = { ...source.weightDecay };
  target.userAllowedExtensions = [...source.userAllowedExtensions];
  target.suspiciousExtensions = [...source.suspiciousExtensions];
}

async function persistConfigSection(configPath, key, value) {
  if (!configPath) {
    return;
  }

  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed[key] = value;
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function normalizeResponsePolicy(policy = {}) {
  if (policy.shutdownSystem) {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: true,
      shutdownSystem: true
    };
  }

  if (policy.killSuspectProcesses) {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: true,
      shutdownSystem: false
    };
  }

  return {
    lockDirectoryPermissions: DEFAULT_RESPONSE_POLICY.lockDirectoryPermissions,
    killSuspectProcesses: DEFAULT_RESPONSE_POLICY.killSuspectProcesses,
    shutdownSystem: DEFAULT_RESPONSE_POLICY.shutdownSystem
  };
}

function toDemoSnapshot(demo) {
  return {
    status: demo.status,
    startedAt: demo.startedAt,
    completedAt: demo.completedAt,
    lastError: demo.lastError,
    workerPid: demo.workerPid,
    runAsUid: demo.runAsUid,
    runAsGid: demo.runAsGid,
    privilegeWarning: demo.privilegeWarning,
    blocked: demo.blocked,
    blockedPath: demo.blocked?.blockedPath ?? null,
    blockedIndex: demo.blocked?.blockedIndex ?? null,
    errorCode: demo.blocked?.errorCode ?? null,
    errorMessage: demo.blocked?.errorMessage ?? null,
    reason: demo.blocked?.reason ?? null
  };
}

function startDemoWorker({ cwd, uid, gid, fileCount }) {
  const forkOptions = {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      DEMO_FILE_COUNT: String(normalizeDemoFileCount(fileCount))
    }
  };

  if (Number.isInteger(uid)) {
    forkOptions.uid = uid;
  }

  if (Number.isInteger(gid)) {
    forkOptions.gid = gid;
  }

  return fork(DEMO_WORKER_PATH, [], forkOptions);
}

function handleDemoWorkerMessage({ message, state, eventBus, target, worker }) {
  if (!message || state.demo.worker !== worker) {
    return;
  }

  if (message.type === 'fs_event') {
    const now = new Date();
    eventBus.emit(EVENT_NAMES.FS_EVENT, {
      type: message.payload?.eventType,
      path: message.payload?.filePath,
      observedAt: now.toISOString(),
      observedTs: now.getTime(),
      monitorTargetId: target.id,
      monitorRootPath: target.rootPath
    });
    return;
  }

  if (message.type === 'completed') {
    finishDemoWorker({
      state,
      eventBus,
      status: 'completed',
      worker
    });
    return;
  }

  if (message.type === 'blocked') {
    const payload = message.payload ?? {};
    finishDemoWorker({
      state,
      eventBus,
      status: 'failed',
      lastError: payload.reason ?? payload.errorMessage ?? 'Demo was blocked before all files were encrypted',
      blocked: {
        blockedPath: payload.blockedPath ?? null,
        blockedIndex: payload.blockedIndex ?? null,
        errorCode: payload.errorCode ?? null,
        errorMessage: payload.errorMessage ?? null,
        reason: payload.reason ?? null
      },
      worker
    });
    return;
  }

  if (message.type === 'aborted') {
    finishDemoWorker({
      state,
      eventBus,
      status: 'aborted',
      worker
    });
    return;
  }

  if (message.type === 'error') {
    finishDemoWorker({
      state,
      eventBus,
      status: 'failed',
      lastError: message.payload?.message ?? 'Demo worker failed',
      worker
    });
  }
}

function finishDemoWorker({ state, eventBus, status, lastError = null, blocked = null, worker }) {
  if (state.demo.worker !== worker) {
    return;
  }

  if (state.demo.stopTimer) {
    clearTimeout(state.demo.stopTimer);
  }

  state.demo = {
    ...state.demo,
    status,
    completedAt: new Date().toISOString(),
    lastError,
    blocked,
    worker: null,
    workerPid: null,
    stopTimer: null
  };

  const eventName = status === 'completed'
    ? EVENT_NAMES.DEMO_COMPLETED
    : EVENT_NAMES.DEMO_ABORTED;
  eventBus.emit(eventName, toDemoSnapshot(state.demo));
}

function sendDemoWorkerMessage(worker, message) {
  if (!worker?.send || worker.killed) {
    return false;
  }

  try {
    worker.send(message);
    return true;
  } catch {
    return false;
  }
}

function stopDemoWorkerForShutdown(state) {
  if (!state.demo.worker) {
    return;
  }

  if (state.demo.stopTimer) {
    clearTimeout(state.demo.stopTimer);
  }

  const worker = state.demo.worker;
  sendDemoWorkerMessage(worker, { type: 'abort' });
  worker.kill?.('SIGTERM');
  state.demo = {
    ...state.demo,
    status: 'aborted',
    completedAt: new Date().toISOString(),
    worker: null,
    workerPid: null,
    stopTimer: null
  };
}

function resolveDemoRunIdentity(config) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const currentGid = typeof process.getgid === 'function' ? process.getgid() : null;
  const explicitUid = parseOptionalInteger(config.demo?.runAsUid);
  const explicitGid = parseOptionalInteger(config.demo?.runAsGid);
  const sudoUid = parseOptionalInteger(process.env.SUDO_UID);
  const sudoGid = parseOptionalInteger(process.env.SUDO_GID);

  let runAsUid = currentUid;
  let runAsGid = currentGid;
  let source = 'current';

  if (Number.isInteger(explicitUid) && Number.isInteger(explicitGid)) {
    runAsUid = explicitUid;
    runAsGid = explicitGid;
    source = 'config';
  } else if (Number.isInteger(sudoUid) && Number.isInteger(sudoGid)) {
    runAsUid = sudoUid;
    runAsGid = sudoGid;
    source = 'sudo';
  }

  let privilegeWarning = null;
  const canSwitchUser = currentUid === 0 && Number.isInteger(runAsUid) && Number.isInteger(runAsGid);
  const requestedDifferentUser =
    Number.isInteger(currentUid) &&
    Number.isInteger(runAsUid) &&
    runAsUid !== currentUid;

  if (!canSwitchUser && requestedDifferentUser) {
    privilegeWarning = `권한 분리 비활성: ${source} 권한(${runAsUid}:${runAsGid})으로 전환할 수 없습니다.`;
    runAsUid = currentUid;
    runAsGid = currentGid;
  }

  if (runAsUid === 0) {
    privilegeWarning = '권한 분리 비활성: 데모 worker가 root로 실행됩니다.';
  }

  return {
    runAsUid,
    runAsGid,
    forkUid: canSwitchUser ? runAsUid : undefined,
    forkGid: canSwitchUser ? runAsGid : undefined,
    privilegeWarning
  };
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function createRuntimeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function countFiles(rootPath) {
  if (!rootPath) {
    return 0;
  }

  try {
    let count = 0;
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(rootPath, entry.name);

      if (entry.isDirectory()) {
        count += countFiles(entryPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }

    return count;
  } catch {
    return 0;
  }
}

export function createDemoRuntime() {
  return {
    async getSnapshot() {
      return {
        activeTarget: '/home/bangjyuhyeon/team404/test_folder',
        quarantineJobs: [
          {
            incidentId: 'demo-incident-001',
            rootPath: '/etc/passwd_backup',
            entryCount: 5
          }
        ]
      };
    },
    async restoreIncident(id) {
      console.log(`[INFO] Incident ${id} restored.`);
      return { success: true };
    }
  };
}
