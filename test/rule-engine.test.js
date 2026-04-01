import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/shared/utils/create-event-bus.js';
import { RuleEngine } from '../src/rules/rule-engine.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

test('RuleEngine emits rule_match after threshold is crossed', async () => {
  const eventBus = createEventBus();
  const ruleEngine = new RuleEngine({
    eventBus,
    config: {
      rules: {
        burstWindowMs: 5000,
        burstThreshold: 3,
        incidentCooldownMs: 1000
      }
    }
  });

  const matches = [];
  eventBus.on(EVENT_NAMES.RULE_MATCH, (match) => {
    matches.push(match);
  });

  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id: '1',
    type: 'modify',
    observedTs: 1000,
    observedAt: new Date(1000).toISOString(),
    path: '/tmp/watch/a.txt',
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });
  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id: '2',
    type: 'modify',
    observedTs: 1500,
    observedAt: new Date(1500).toISOString(),
    path: '/tmp/watch/b.txt',
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });
  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id: '3',
    type: 'modify',
    observedTs: 2000,
    observedAt: new Date(2000).toISOString(),
    path: '/tmp/watch/c.txt',
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/watch'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, 'burst-threshold');
  assert.equal(matches[0].eventCount, 3);

  ruleEngine.stop();
});
