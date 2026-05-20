import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/shared/utils/create-event-bus.js';
import { RuleEngine } from '../src/rules/rule-engine.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

function createRuleEngine() {
  const eventBus = createEventBus();
  const ruleEngine = new RuleEngine({
    eventBus,
    config: {
      rules: {
        definitions: []
      }
    }
  });

  const matches = [];
  eventBus.on(EVENT_NAMES.RULE_MATCH, (match) => {
    matches.push(match);
  });

  return { eventBus, ruleEngine, matches };
}

function emitFsEvent(
  eventBus,
  { id, type = 'modify', observedTs = 1000, path, monitorTargetId = 'sandbox' }
) {
  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id,
    type,
    observedTs,
    observedAt: new Date(observedTs).toISOString(),
    path,
    monitorTargetId,
    monitorRootPath: `/tmp/${monitorTargetId}`
  });
}

test('RuleEngine emits critical extension weight burst after one target exceeds bucket weight', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine();

  for (let index = 1; index <= 11; index += 1) {
    emitFsEvent(eventBus, {
      id: String(index),
      path: `/tmp/watch/file-${index}.locked`
    });
  }

  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, 'extension-weight-burst');
  assert.equal(matches[0].severity, 'critical');
  assert.equal(matches[0].autoQuarantine, true);
  assert.equal(matches[0].eventCount, 11);
  assert.equal(matches[0].totalWeight, 11);
  assert.equal(matches[0].bucketSecond, 1);
  assert.equal(matches[0].bucketMs, 1000);
  assert.deepEqual(matches[0].eventTypes, ['modify']);
  assert.equal(matches[0].samplePaths.length, 10);

  ruleEngine.stop();
});

test('RuleEngine counts create modify and rename events but ignores delete events', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine();

  for (let index = 1; index <= 4; index += 1) {
    emitFsEvent(eventBus, { id: `create-${index}`, type: 'create', path: `/tmp/watch/c-${index}.unknown` });
    emitFsEvent(eventBus, { id: `delete-${index}`, type: 'delete', path: `/tmp/watch/d-${index}.unknown` });
    emitFsEvent(eventBus, { id: `rename-${index}`, type: 'rename', path: `/tmp/watch/r-${index}.unknown` });
  }

  emitFsEvent(eventBus, { id: 'modify-1', type: 'modify', path: '/tmp/watch/m-1.unknown' });
  emitFsEvent(eventBus, { id: 'modify-2', type: 'modify', path: '/tmp/watch/m-2.unknown' });

  assert.equal(matches.length, 0);

  emitFsEvent(eventBus, { id: 'modify-3', type: 'modify', path: '/tmp/watch/m-3.unknown' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventCount, 11);
  assert.deepEqual(matches[0].eventTypes, ['create', 'rename', 'modify']);

  ruleEngine.stop();
});

test('RuleEngine keeps buckets per target and per wall-clock second', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine();

  for (let index = 1; index <= 10; index += 1) {
    emitFsEvent(eventBus, {
      id: `a-${index}`,
      observedTs: 1000,
      path: `/tmp/alpha/a-${index}.unknown`,
      monitorTargetId: 'alpha'
    });
    emitFsEvent(eventBus, {
      id: `b-${index}`,
      observedTs: 1000,
      path: `/tmp/beta/b-${index}.unknown`,
      monitorTargetId: 'beta'
    });
  }

  assert.equal(matches.length, 0);

  emitFsEvent(eventBus, {
    id: 'alpha-next-second',
    observedTs: 2000,
    path: '/tmp/alpha/next.unknown',
    monitorTargetId: 'alpha'
  });
  emitFsEvent(eventBus, {
    id: 'beta-same-second',
    observedTs: 1000,
    path: '/tmp/beta/final.unknown',
    monitorTargetId: 'beta'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].monitorTargetId, 'beta');
  assert.equal(matches[0].bucketSecond, 1);
  assert.equal(matches[0].totalWeight, 11);

  ruleEngine.stop();
});
