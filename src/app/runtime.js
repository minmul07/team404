import { createEventBus } from '../shared/utils/create-event-bus.js';
import { MonitorService } from '../collector/monitor-service.js';
import { IncidentStore } from '../incidents/incident-store.js';
import { RuleEngine } from '../rules/rule-engine.js';

export function createRuntime(config) {
  const eventBus = createEventBus();
  const incidentStore = new IncidentStore({ eventBus });
  const ruleEngine = new RuleEngine({ eventBus, config });
  const monitorService = new MonitorService({ config, eventBus });

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
      incidentStore.stop();
      state.stoppedAt = new Date().toISOString();
    },
    getHealth() {
      const now = Date.now();
      const startedAtTs = state.startedAt ? Date.parse(state.startedAt) : null;

      return {
        status: monitorService.getHealth().status,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        uptimeMs: startedAtTs ? now - startedAtTs : 0,
        lastFsEventAt: state.lastFsEventAt,
        lastRuleMatchAt: state.lastRuleMatchAt,
        monitor: monitorService.getHealth(),
        rules: ruleEngine.getState(),
        incidents: incidentStore.getSummary()
      };
    },
    getSnapshot() {
      return {
        health: this.getHealth(),
        incidents: incidentStore.getIncidents(),
        alerts: incidentStore.getAlerts(),
        quarantineJobs: incidentStore.getQuarantineJobs()
      };
    }
  };
}
