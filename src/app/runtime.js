import { createEventBus } from '../shared/utils/create-event-bus.js';
import { MonitorService } from '../collector/monitor-service.js';
import { IncidentStore } from '../incidents/incident-store.js';
import { RuleEngine } from '../rules/rule-engine.js';
import { QuarantineService } from '../isolation/quarantine-service.js';
import { startAttack } from '../simulator/demo.js';
import { EVENT_NAMES } from '../shared/contracts/event-names.js';

export function createRuntime(config, options = {}) {
  const eventBus = createEventBus();
  const incidentStore = new IncidentStore({ eventBus });
  const ruleEngine = new RuleEngine({ eventBus, config });
  const quarantineService = new QuarantineService({ eventBus });
  const monitorService = new MonitorService({
    config,
    eventBus,
    watchOptions: options.watchOptions ?? options.watch ?? {}
  });

  const state = {
    startedAt: null,
    stoppedAt: null,
    lastFsEventAt: null,
    lastRuleMatchAt: null
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
    async enableDemoMode() {
      await monitorService.setWatchOptions({ demo: true });
      const target = monitorService.getHealth().activeTarget;
      setTimeout(() => {
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
        }).catch(console.error);
      }, 500);
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
        activeMode: monitorHealth.activeMode,
        activeTarget: monitorHealth.activeTarget,
        monitor: monitorHealth,
        rules: ruleEngine.getState(),
        incidents: incidentStore.getSummary()
      };
    },
    getSnapshot() {
      const monitorHealth = monitorService.getHealth();
      return {
        health: this.getHealth(),
        activeMode: monitorHealth.activeMode,
        activeTarget: monitorHealth.activeTarget,
        incidents: incidentStore.getIncidents(),
        alerts: incidentStore.getAlerts(),
        quarantineJobs: quarantineService.getQuarantineJobs()
      };
    },                          // ← 콤마 추가
    async restoreIncident(incidentId) {
      return quarantineService.restore(incidentId);
    }
  };
}
