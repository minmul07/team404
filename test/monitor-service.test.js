import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { MonitorService } from '../src/collector/monitor-service.js';
import { createEventBus } from '../src/shared/utils/create-event-bus.js';

const PROJECT_ROOT = process.cwd();
const DEMO_TARGET_ROOT = path.resolve(PROJECT_ROOT, 'tmp/demo-target');

function createConfig() {
  return {
    monitor: {
      scriptPath: '/tmp/fake-monitor.sh',
      restartDelayMs: 1000,
      movePairWindowMs: 500,
      targets: [
        {
          id: 'sandbox',
          rootPath: '/tmp/configured-watch',
          enabled: true,
          autoQuarantineEnabled: false,
          demoAllowed: true
        },
        {
          id: 'archive',
          rootPath: '/tmp/configured-archive',
          enabled: true,
          autoQuarantineEnabled: false,
          demoAllowed: false
        }
      ]
    },
    meta: {
      projectRoot: PROJECT_ROOT
    }
  };
}

test('MonitorService uses all configured targets by default', () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus()
  });

  const health = service.getHealth();
  assert.equal(health.activeMode, 'config');
  assert.equal(health.activeTarget.rootPath, '/tmp/configured-watch');
  assert.deepEqual(
    health.targets.map((target) => target.rootPath),
    ['/tmp/configured-watch', '/tmp/configured-archive']
  );
});

test('MonitorService switches to demo mode when created with a demo flag', () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus(),
    watchOptions: { demo: true }
  });

  const health = service.getHealth();
  assert.equal(health.activeMode, 'demo');
  assert.equal(health.activeTarget.id, 'demo-target');
  assert.equal(health.activeTarget.rootPath, DEMO_TARGET_ROOT);
  assert.equal(health.targets[0].rootPath, DEMO_TARGET_ROOT);
});

test('MonitorService switches to an explicit target path when provided at creation time', () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus(),
    watchOptions: { targetPath: './tmp/manual-target' }
  });

  const health = service.getHealth();
  assert.equal(health.activeMode, 'target');
  assert.ok(health.activeTarget.rootPath.endsWith('/tmp/manual-target'));
  assert.equal(health.targets[0].rootPath, health.activeTarget.rootPath);
});

test('MonitorService can toggle demo mode on and off after creation', async () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus()
  });

  await service.setWatchOptions({ demo: true });
  assert.equal(service.getHealth().activeMode, 'demo');
  assert.equal(service.getHealth().activeTarget.rootPath, DEMO_TARGET_ROOT);

  await service.setWatchOptions();
  assert.equal(service.getHealth().activeMode, 'config');
  assert.equal(service.getHealth().activeTarget.rootPath, '/tmp/configured-watch');
  assert.equal(service.getHealth().targets.length, 2);
});

test('MonitorService can switch to a new target path after creation', async () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus()
  });

  await service.setWatchOptions({ targetPath: './tmp/api-target' });
  assert.equal(service.getHealth().activeMode, 'target');
  assert.ok(service.getHealth().activeTarget.rootPath.endsWith('/tmp/api-target'));

  await service.setWatchOptions();
  assert.equal(service.getHealth().activeMode, 'config');
  assert.equal(service.getHealth().activeTarget.rootPath, '/tmp/configured-watch');
  assert.equal(service.getHealth().targets.length, 2);
});
