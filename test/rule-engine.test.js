import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/shared/utils/create-event-bus.js';
import { RuleEngine } from '../src/rules/rule-engine.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

function createRuleEngine(configOverrides = {}) {
  const eventBus = createEventBus();
  const ruleEngine = new RuleEngine({
    eventBus,
    config: {
      rules: {
        definitions: []
      },
      ...configOverrides
    }
  });

  const matches = [];
  const weightUpdates = [];
  eventBus.on(EVENT_NAMES.RULE_MATCH, (match) => {
    matches.push(match);
  });
  eventBus.on(EVENT_NAMES.RULE_WEIGHT_UPDATED, (payload) => {
    weightUpdates.push(payload);
  });

  return { eventBus, ruleEngine, matches, weightUpdates };
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

test('RuleEngine emits weight updates and critical extension weight burst after one target exceeds bucket weight', () => {
  const { eventBus, ruleEngine, matches, weightUpdates } = createRuleEngine();

  for (let index = 1; index <= 6; index += 1) {
    emitFsEvent(eventBus, {
      id: String(index),
      path: `/tmp/watch/file-${index}.locked`
    });
  }

  assert.equal(matches.length, 1);
  assert.equal(weightUpdates.length, 6);
  assert.equal(weightUpdates[5].currentWeight, 12);
  assert.equal(weightUpdates[5].thresholdWeight, 10);
  assert.equal(matches[0].ruleId, 'extension-weight-burst');
  assert.equal(matches[0].severity, 'critical');
  assert.equal(matches[0].autoQuarantine, true);
  assert.equal(matches[0].eventCount, 6);
  assert.equal(matches[0].totalWeight, 12);
  assert.deepEqual(matches[0].eventTypes, ['modify']);
  assert.equal(matches[0].samplePaths.length, 6);

  ruleEngine.stop();
});

test('RuleEngine emits one match while a target bucket remains over threshold', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine({
    detectionPolicy: {
      thresholdWeight: 4,
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
        amount: 10
      },
      userAllowedExtensions: [],
      suspiciousExtensions: ['locked']
    }
  });

  for (let index = 1; index <= 3; index += 1) {
    emitFsEvent(eventBus, {
      id: `first-burst-${index}`,
      path: `/tmp/watch/first-burst-${index}.locked`
    });
  }

  assert.equal(matches.length, 1);

  emitFsEvent(eventBus, { id: 'still-over-1', path: '/tmp/watch/still-over-1.locked' });
  emitFsEvent(eventBus, { id: 'still-over-2', path: '/tmp/watch/still-over-2.locked' });

  assert.equal(matches.length, 1);

  ruleEngine.applyWeightDecay();

  for (let index = 1; index <= 3; index += 1) {
    emitFsEvent(eventBus, {
      id: `second-burst-${index}`,
      path: `/tmp/watch/second-burst-${index}.locked`
    });
  }

  assert.equal(matches.length, 2);

  ruleEngine.stop();
});

test('RuleEngine uses configured threshold weight', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine({
    detectionPolicy: {
      thresholdWeight: 12,
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
      userAllowedExtensions: [],
      suspiciousExtensions: ['locked']
    }
  });

  for (let index = 1; index <= 6; index += 1) {
    emitFsEvent(eventBus, {
      id: String(index),
      path: `/tmp/watch/file-${index}.locked`
    });
  }

  assert.equal(matches.length, 0);

  emitFsEvent(eventBus, {
    id: '7',
    path: '/tmp/watch/file-7.locked'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].thresholdWeight, 12);
  assert.equal(matches[0].totalWeight, 14);

  ruleEngine.stop();
});

test('RuleEngine applies configured event multipliers to extension weights', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine({
    detectionPolicy: {
      weights: {
        knownExtension: 0.1,
        unknownExtension: 1,
        noExtension: 1,
        suspiciousExtension: 2
      },
      eventMultipliers: {
        create: 1,
        modify: 1,
        rename: 2
      },
      userAllowedExtensions: [],
      suspiciousExtensions: ['locked']
    }
  });

  for (let index = 1; index <= 3; index += 1) {
    emitFsEvent(eventBus, {
      id: `rename-${index}`,
      type: 'rename',
      path: `/tmp/watch/file-${index}.locked`
    });
  }

  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventCount, 3);
  assert.equal(matches[0].totalWeight, 12);
  assert.deepEqual(matches[0].eventTypes, ['rename']);

  ruleEngine.stop();
});

test('RuleEngine counts create modify and rename events but ignores delete events', () => {
  const { eventBus, ruleEngine, matches } = createRuleEngine();

  for (let index = 1; index <= 3; index += 1) {
    emitFsEvent(eventBus, { id: `create-${index}`, type: 'create', path: `/tmp/watch/c-${index}.unknown` });
    emitFsEvent(eventBus, { id: `delete-${index}`, type: 'delete', path: `/tmp/watch/d-${index}.unknown` });
    emitFsEvent(eventBus, { id: `rename-${index}`, type: 'rename', path: `/tmp/watch/r-${index}.unknown` });
  }

  emitFsEvent(eventBus, { id: 'modify-1', type: 'modify', path: '/tmp/watch/m-1.unknown' });
  emitFsEvent(eventBus, { id: 'modify-2', type: 'modify', path: '/tmp/watch/m-2.unknown' });

  assert.equal(matches.length, 0);

  emitFsEvent(eventBus, { id: 'modify-3', type: 'modify', path: '/tmp/watch/m-3.unknown' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventCount, 9);
  assert.deepEqual(matches[0].eventTypes, ['create', 'rename', 'modify']);

  ruleEngine.stop();
});

test('RuleEngine keeps accumulated weights per target until decay', () => {
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

  assert.equal(matches.length, 2);
  assert.equal(matches[0].monitorTargetId, 'alpha');
  assert.equal(matches[0].totalWeight, 11);
  assert.equal(matches[1].monitorTargetId, 'beta');
  assert.equal(matches[1].totalWeight, 11);

  ruleEngine.stop();
});

test('RuleEngine resetWeights clears accumulated target weights and emits zero update', () => {
  const { eventBus, ruleEngine, matches, weightUpdates } = createRuleEngine();

  for (let index = 1; index <= 6; index += 1) {
    emitFsEvent(eventBus, {
      id: `before-reset-${index}`,
      path: `/tmp/watch/before-reset-${index}.locked`
    });
  }

  assert.equal(matches.length, 1);
  assert.equal(weightUpdates.at(-1).currentWeight, 12);

  ruleEngine.resetWeights();

  assert.equal(weightUpdates.at(-1).eventType, 'reset');
  assert.equal(weightUpdates.at(-1).currentWeight, 0);

  emitFsEvent(eventBus, {
    id: 'after-reset-1',
    path: '/tmp/watch/after-reset-1.locked'
  });

  assert.equal(weightUpdates.at(-1).currentWeight, 2);
  assert.equal(matches.length, 1);

  ruleEngine.stop();
});

test('RuleEngine decays displayed bucket weight by configured amount', () => {
  const { eventBus, ruleEngine, weightUpdates } = createRuleEngine({
    detectionPolicy: {
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
        amount: 3
      },
      userAllowedExtensions: [],
      suspiciousExtensions: ['locked']
    }
  });

  emitFsEvent(eventBus, {
    id: 'decay-1',
    path: '/tmp/watch/decay-1.locked'
  });
  emitFsEvent(eventBus, {
    id: 'decay-2',
    path: '/tmp/watch/decay-2.locked'
  });

  assert.equal(weightUpdates.at(-1).currentWeight, 4);

  ruleEngine.applyWeightDecay();

  assert.equal(weightUpdates.at(-1).eventType, 'decay');
  assert.equal(weightUpdates.at(-1).eventWeight, -3);
  assert.equal(weightUpdates.at(-1).currentWeight, 1);
  assert.equal(weightUpdates.at(-1).decay.intervalMs, 1000);

  ruleEngine.applyWeightDecay();

  assert.equal(weightUpdates.at(-1).currentWeight, 0);

  ruleEngine.stop();
});
