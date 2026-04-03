import test from 'node:test';
import assert from 'node:assert/strict';

import { attachConsoleEventLogger } from '../src/app/console-event-logger.js';
import { createEventBus } from '../src/shared/utils/create-event-bus.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

test('attachConsoleEventLogger writes fs_event payloads to the provided logger', () => {
  const eventBus = createEventBus();
  const calls = [];
  const detach = attachConsoleEventLogger({
    eventBus,
    log(...args) {
      calls.push(args);
    }
  });

  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    observedAt: '2026-04-03T00:00:00.000Z',
    type: 'modify',
    path: '/tmp/demo-target/file.txt',
    previousPath: null,
    monitorTargetId: 'demo-target',
    monitorRootPath: '/tmp/demo-target'
  });

  detach();

  assert.deepEqual(calls, [
    [
      '[fs_event]',
      {
        observedAt: '2026-04-03T00:00:00.000Z',
        type: 'modify',
        path: '/tmp/demo-target/file.txt',
        previousPath: null,
        monitorTargetId: 'demo-target',
        monitorRootPath: '/tmp/demo-target'
      }
    ]
  ]);
});

test('attachConsoleEventLogger stops logging after detach is called', () => {
  const eventBus = createEventBus();
  const calls = [];
  const detach = attachConsoleEventLogger({
    eventBus,
    log(...args) {
      calls.push(args);
    }
  });

  detach();

  eventBus.emit(EVENT_NAMES.FS_EVENT, {
    observedAt: '2026-04-03T00:00:00.000Z',
    type: 'modify',
    path: '/tmp/demo-target/file.txt'
  });

  assert.equal(calls.length, 0);
});
