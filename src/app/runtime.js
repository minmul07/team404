import fs from 'node:fs';
import path from 'node:path';

import { createEventBus } from '../shared/utils/create-event-bus.js';
import { MonitorService } from '../collector/monitor-service.js';
import { IncidentStore } from '../incidents/incident-store.js';
import { RuleEngine } from '../rules/rule-engine.js';
import { QuarantineService } from '../isolation/quarantine-service.js';
import { resetDemo, startAttack } from '../simulator/demo.js';
import { EVENT_NAMES } from '../shared/contracts/event-names.js';

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
  const quarantineService = new QuarantineService({
    eventBus,
    getResponsePolicy: () => ({ ...responsePolicy })
  });
  const monitorService = new MonitorService({
    config,
    eventBus,
    watchOptions: options.watchOptions ?? options.watch ?? {}
  });

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
      controller: null
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
    updateResponsePolicy(nextPolicy = {}) {
      const normalizedPolicy = normalizeResponsePolicy(nextPolicy);
      responsePolicy.lockDirectoryPermissions = normalizedPolicy.lockDirectoryPermissions;
      responsePolicy.killSuspectProcesses = normalizedPolicy.killSuspectProcesses;
      responsePolicy.shutdownSystem = normalizedPolicy.shutdownSystem;
      return this.getResponsePolicy();
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
      const controller = new AbortController();
      state.demo = {
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        controller
      };
      eventBus.emit(EVENT_NAMES.DEMO_STARTED, toDemoSnapshot(state.demo));

      startAttack((eventType, filePath) => {
        const now = new Date();
        eventBus.emit(EVENT_NAMES.FS_EVENT, {
          type: eventType,
          path: filePath,
          observedAt: now.toISOString(),
          observedTs: now.getTime(),
          monitorTargetId: target.id,
          monitorRootPath: target.rootPath
        });
      }, { signal: controller.signal }).then((result) => {
        const completedAt = new Date().toISOString();
        state.demo.controller = null;
        state.demo.completedAt = completedAt;

        if (result?.status === 'aborted') {
          state.demo.status = 'aborted';
          eventBus.emit(EVENT_NAMES.DEMO_ABORTED, toDemoSnapshot(state.demo));
          return;
        }

        if (result?.status === 'blocked') {
          state.demo.status = 'failed';
          state.demo.lastError = 'Demo was blocked before all files were encrypted';
          eventBus.emit(EVENT_NAMES.DEMO_ABORTED, toDemoSnapshot(state.demo));
          return;
        }

        state.demo.status = 'completed';
        eventBus.emit(EVENT_NAMES.DEMO_COMPLETED, toDemoSnapshot(state.demo));
      }).catch((error) => {
        state.demo = {
          ...state.demo,
          status: 'failed',
          completedAt: new Date().toISOString(),
          lastError: error.message,
          controller: null
        };
        eventBus.emit(EVENT_NAMES.DEMO_ABORTED, toDemoSnapshot(state.demo));
        console.error(error);
      });

      return this.getSnapshot();
    },
    async stopDemo() {
      if (state.demo.status !== 'running' || !state.demo.controller) {
        return this.getSnapshot();
      }

      state.demo.status = 'stopping';
      state.demo.controller.abort();
      return this.getSnapshot();
    },
    async resetDemo() {
      if (state.demo.status === 'running' || state.demo.status === 'stopping') {
        throw createRuntimeError('Demo reset is not available while demo is running', 409);
      }

      resetDemo();
      state.demo = {
        status: 'ready',
        startedAt: null,
        completedAt: null,
        lastError: null,
        controller: null
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
    lastError: demo.lastError
  };
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
