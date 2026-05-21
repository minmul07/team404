import test from 'node:test';
import assert from 'node:assert/strict';

import { MonitorService } from '../src/collector/monitor-service.js';
import { createEventBus } from '../src/shared/utils/create-event-bus.js';

const PROJECT_ROOT = process.cwd();
const DEMO_TARGET_ROOT = `${PROJECT_ROOT}/tmp/demo-target`;

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

test('MonitorService switches to explicit target paths when provided at creation time', () => {
  const service = new MonitorService({
    config: createConfig(),
    eventBus: createEventBus(),
    watchOptions: { targetPaths: ['./tmp/manual-a', './tmp/manual-b'] }
  });

  const health = service.getHealth();
  assert.equal(health.activeMode, 'target');
  assert.ok(health.activeTarget.rootPath.endsWith('/tmp/manual-a'));
  assert.deepEqual(
    health.targets.map((target) => target.id),
    ['manual-1', 'manual-2']
  );
  assert.ok(health.targets[1].rootPath.endsWith('/tmp/manual-b'));
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


test('MonitorService auto mode uses auditd backend when it starts', async () => {
  const auditdBackends = [];
  const inotifyBackends = [];
  const config = createConfig();
  config.monitor.backendMode = 'auto';
  const service = new MonitorService({
    config,
    eventBus: createEventBus(),
    backendFactories: {
      auditd: createBackendFactory('auditd', auditdBackends),
      inotify: createBackendFactory('inotify', inotifyBackends)
    }
  });

  await service.start();

  const health = service.getHealth();
  assert.equal(health.requestedBackend, 'auto');
  assert.equal(health.activeBackend, 'auditd');
  assert.equal(health.pidTrackingAvailable, true);
  assert.equal(auditdBackends.length, 1);
  assert.equal(inotifyBackends.length, 0);

  await service.stop();
});

test('MonitorService auto mode falls back to inotify when auditd fails', async () => {
  const auditdBackends = [];
  const inotifyBackends = [];
  const config = createConfig();
  config.monitor.backendMode = 'auto';
  const service = new MonitorService({
    config,
    eventBus: createEventBus(),
    backendFactories: {
      auditd: createBackendFactory('auditd', auditdBackends, { failStart: true, failMessage: 'auditctl denied' }),
      inotify: createBackendFactory('inotify', inotifyBackends)
    }
  });

  await service.start();

  const health = service.getHealth();
  assert.equal(health.status, 'running');
  assert.equal(health.activeBackend, 'inotify');
  assert.equal(health.pidTrackingAvailable, false);
  assert.equal(health.fallbackReason, 'auditctl denied');

  await service.stop();
});

test('MonitorService auditd mode degrades without fallback when auditd fails', async () => {
  const auditdBackends = [];
  const inotifyBackends = [];
  const config = createConfig();
  config.monitor.backendMode = 'auditd';
  const service = new MonitorService({
    config,
    eventBus: createEventBus(),
    backendFactories: {
      auditd: createBackendFactory('auditd', auditdBackends, { failStart: true, failMessage: 'audit log unreadable' }),
      inotify: createBackendFactory('inotify', inotifyBackends)
    }
  });

  await service.start();

  const health = service.getHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.activeBackend, 'auditd');
  assert.equal(health.fallbackReason, null);
  assert.equal(health.lastError, 'audit log unreadable');
  assert.equal(inotifyBackends.length, 0);
});

test('MonitorService restarts backend when backend mode changes', async () => {
  const auditdBackends = [];
  const inotifyBackends = [];
  const config = createConfig();
  config.monitor.backendMode = 'inotify';
  const service = new MonitorService({
    config,
    eventBus: createEventBus(),
    backendFactories: {
      auditd: createBackendFactory('auditd', auditdBackends),
      inotify: createBackendFactory('inotify', inotifyBackends)
    }
  });

  await service.start();
  await service.setBackendMode('auditd');

  assert.equal(config.monitor.backendMode, 'auditd');
  assert.equal(inotifyBackends[0].stopCalls, 1);
  assert.equal(auditdBackends[0].startCalls, 1);
  assert.equal(service.getHealth().activeBackend, 'auditd');

  await service.stop();
});

function createBackendFactory(name, store, options = {}) {
  return ({ onHealth }) => {
    const backend = {
      startCalls: 0,
      stopCalls: 0,
      status: 'idle',
      pid: name === 'auditd' ? 4242 : 3131,
      lastError: null,
      async start() {
        this.startCalls += 1;
        if (options.failStart) {
          this.lastError = options.failMessage ?? `${name} failed`;
          throw new Error(this.lastError);
        }
        this.status = 'running';
        onHealth(this.getHealth());
      },
      async stop() {
        this.stopCalls += 1;
        this.status = 'stopped';
        onHealth(this.getHealth());
      },
      getHealth() {
        return {
          name,
          status: this.status,
          pid: this.status === 'running' ? this.pid : null,
          lastEventAt: null,
          lastError: this.lastError,
          restartCount: 0
        };
      }
    };
    store.push(backend);
    return backend;
  };
}
