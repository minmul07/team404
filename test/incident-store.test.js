import test from 'node:test';
import assert from 'node:assert/strict';

import { IncidentStore } from '../src/incidents/incident-store.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';
import { createEventBus } from '../src/shared/utils/create-event-bus.js';

test('IncidentStore preserves enriched rule_match fields across incident updates', () => {
  const eventBus = createEventBus();
  const incidentStore = new IncidentStore({ eventBus });

  eventBus.emit(EVENT_NAMES.RULE_MATCH, {
    id: 'match-1',
    ruleId: 'burst-modify',
    ruleName: 'Bulk Modify Burst',
    eventType: 'modify',
    severity: 'critical',
    autoQuarantine: true,
    reason: 'modify events reached 5/5 within 1000ms',
    observedAt: '2026-04-02T00:00:00.000Z',
    eventCount: 5,
    samplePaths: ['/tmp/watch/a.txt'],
    eventTypes: ['modify'],
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });

  eventBus.emit(EVENT_NAMES.RULE_MATCH, {
    id: 'match-2',
    ruleId: 'burst-delete',
    ruleName: 'Bulk Delete Burst',
    eventType: 'delete',
    severity: 'high',
    autoQuarantine: false,
    reason: 'delete events reached 5/5 within 1000ms',
    observedAt: '2026-04-02T00:00:05.000Z',
    eventCount: 6,
    samplePaths: ['/tmp/watch/b.txt'],
    eventTypes: ['delete'],
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });

  const [incident] = incidentStore.getIncidents();
  const [latestAlert] = incidentStore.getAlerts();

  assert.equal(incident.ruleMatches, 2);
  assert.equal(incident.totalObservedEvents, 6);
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.autoQuarantine, true);
  assert.equal(incident.reason, 'delete events reached 5/5 within 1000ms');
  assert.deepEqual(incident.eventTypes, ['modify', 'delete']);
  assert.deepEqual(incident.matchedRuleIds, ['burst-modify', 'burst-delete']);
  assert.deepEqual(incident.matchedRuleNames, ['Bulk Modify Burst', 'Bulk Delete Burst']);
  assert.equal(latestAlert.ruleId, 'burst-delete');

  incidentStore.stop();
});

test('IncidentStore clear removes incidents alerts and quarantine jobs', () => {
  const eventBus = createEventBus();
  const incidentStore = new IncidentStore({ eventBus });

  eventBus.emit(EVENT_NAMES.RULE_MATCH, {
    id: 'match-1',
    ruleId: 'burst-modify',
    ruleName: 'Bulk Modify Burst',
    eventType: 'modify',
    severity: 'critical',
    autoQuarantine: true,
    reason: 'modify events reached 5/5 within 1000ms',
    observedAt: '2026-04-02T00:00:00.000Z',
    eventCount: 5,
    samplePaths: ['/tmp/watch/a.txt'],
    eventTypes: ['modify'],
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });
  const [incident] = incidentStore.getIncidents();
  eventBus.emit(EVENT_NAMES.QUARANTINE_STARTED, {
    incidentId: incident.id,
    rootPath: '/tmp/watch',
    status: 'quarantining'
  });

  incidentStore.clear();

  assert.deepEqual(incidentStore.getIncidents(), []);
  assert.deepEqual(incidentStore.getAlerts(), []);
  assert.deepEqual(incidentStore.getQuarantineJobs(), []);

  incidentStore.stop();
});
