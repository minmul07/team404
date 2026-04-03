import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/shared/utils/create-event-bus.js';
import { RuleEngine } from '../src/rules/rule-engine.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

function createRuleEngine(definitions) {
  const eventBus = createEventBus();
  const ruleEngine = new RuleEngine({
    eventBus,
    config: {
      rules: {
        definitions
      }
    }
  });

  const matches = [];
  eventBus.on(EVENT_NAMES.RULE_MATCH, (match) => {
    matches.push(match);
  });

  return { eventBus, ruleEngine, matches };
}

function emitFsEvent(eventBus, { id, type, observedTs, path }) {
  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id,
    type,
    observedTs,
    observedAt: new Date(observedTs).toISOString(),
    path,
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });
}

test('RuleEngine emits enriched rule_match after matching event threshold is crossed', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine([
    {
      ruleId: 'bulk-modify',
      ruleName: 'Bulk Modify Burst',
      eventType: 'modify',
      threshold: 3,
      windowMs: 5000,
      incidentCooldownMs: 1000,
      severity: 'critical',
      autoQuarantine: true
    }
  ]);

  emitFsEvent(eventBus, { id: '1', type: 'modify', observedTs: 1000, path: '/tmp/watch/a.txt' });
  emitFsEvent(eventBus, { id: '2', type: 'modify', observedTs: 1500, path: '/tmp/watch/b.txt' });
  emitFsEvent(eventBus, { id: '3', type: 'modify', observedTs: 2000, path: '/tmp/watch/c.txt' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, 'bulk-modify');
  assert.equal(matches[0].ruleName, 'Bulk Modify Burst');
  assert.equal(matches[0].eventType, 'modify');
  assert.equal(matches[0].eventCount, 3);
  assert.equal(matches[0].threshold, 3);
  assert.equal(matches[0].windowMs, 5000);
  assert.equal(matches[0].severity, 'critical');
  assert.equal(matches[0].autoQuarantine, true);
  assert.equal(matches[0].samplePaths.length, 3);
  assert.match(matches[0].reason, /modify events reached 3\/3 within 5000ms/);

  ruleEngine.stop();
});

test('RuleEngine evaluates create and modify rules independently', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine([
    {
      ruleId: 'bulk-create',
      ruleName: 'Bulk Create Burst',
      eventType: 'create',
      threshold: 2,
      windowMs: 5000,
      incidentCooldownMs: 1000,
      severity: 'high',
      autoQuarantine: false
    },
    {
      ruleId: 'bulk-modify',
      ruleName: 'Bulk Modify Burst',
      eventType: 'modify',
      threshold: 3,
      windowMs: 5000,
      incidentCooldownMs: 1000,
      severity: 'critical',
      autoQuarantine: true
    }
  ]);

  emitFsEvent(eventBus, { id: '1', type: 'create', observedTs: 1000, path: '/tmp/watch/new-a.txt' });
  emitFsEvent(eventBus, { id: '2', type: 'modify', observedTs: 1200, path: '/tmp/watch/a.txt' });
  emitFsEvent(eventBus, { id: '3', type: 'modify', observedTs: 1400, path: '/tmp/watch/b.txt' });
  emitFsEvent(eventBus, { id: '4', type: 'create', observedTs: 1600, path: '/tmp/watch/new-b.txt' });
  emitFsEvent(eventBus, { id: '5', type: 'modify', observedTs: 1800, path: '/tmp/watch/c.txt' });

  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((match) => match.ruleId),
    ['bulk-create', 'bulk-modify']
  );
  assert.deepEqual(
    matches.map((match) => match.eventType),
    ['create', 'modify']
  );

  ruleEngine.stop();
});

test('RuleEngine respects per-rule cooldown and ignores non-configured event types', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine([
    {
      ruleId: 'bulk-delete',
      ruleName: 'Bulk Delete Burst',
      eventType: 'delete',
      threshold: 2,
      windowMs: 5000,
      incidentCooldownMs: 3000,
      severity: 'critical',
      autoQuarantine: true
    }
  ]);

  emitFsEvent(eventBus, { id: '1', type: 'rename', observedTs: 1000, path: '/tmp/watch/renamed.txt' });
  emitFsEvent(eventBus, { id: '2', type: 'delete', observedTs: 1500, path: '/tmp/watch/a.txt' });
  emitFsEvent(eventBus, { id: '3', type: 'delete', observedTs: 1700, path: '/tmp/watch/b.txt' });
  emitFsEvent(eventBus, { id: '4', type: 'delete', observedTs: 2500, path: '/tmp/watch/c.txt' });
  emitFsEvent(eventBus, { id: '5', type: 'delete', observedTs: 2600, path: '/tmp/watch/d.txt' });
  emitFsEvent(eventBus, { id: '6', type: 'delete', observedTs: 5000, path: '/tmp/watch/e.txt' });
  emitFsEvent(eventBus, { id: '7', type: 'delete', observedTs: 5200, path: '/tmp/watch/f.txt' });

  assert.equal(matches.length, 2);
  assert.equal(matches[0].eventType, 'delete');
  assert.equal(matches[1].eventType, 'delete');
  assert.ok(matches[1].observedTs - matches[0].observedTs >= 3000);

  ruleEngine.stop();
});
