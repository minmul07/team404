import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/app/runtime.js';
import { startAttack } from '../src/simulator/demo.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

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
        }
      ]
    },
    rules: {
      definitions: [
        {
          ruleId: 'burst-modify',
          ruleName: 'Modify Burst',
          eventType: 'modify',
          threshold: 3,
          windowMs: 5000,
          incidentCooldownMs: 15000,
          severity: 'high',
          autoQuarantine: false
        }
      ]
    },
    meta: {
      projectRoot: PROJECT_ROOT
    }
  };
}

test('createRuntime starts in demo mode when watchOptions.demo is enabled', () => {
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true }
  });

  const health = runtime.getHealth();
  assert.equal(health.status, 'idle');
  assert.equal(health.activeMode, 'demo');
  assert.equal(health.activeTarget.id, 'demo-target');
  assert.equal(health.activeTarget.rootPath, DEMO_TARGET_ROOT);
});

test('createRuntime defaults response policy to directory permission lock only', () => {
  const runtime = createRuntime(createConfig());

  assert.deepEqual(runtime.getResponsePolicy(), {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });

  assert.deepEqual(runtime.getSnapshot().responsePolicy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });
});

test('createRuntime updates response policy', () => {
  const runtime = createRuntime(createConfig());

  const policy = runtime.updateResponsePolicy({
    lockDirectoryPermissions: false,
    killSuspectProcesses: true,
    shutdownSystem: false
  });

  assert.deepEqual(policy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: true,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });
  assert.deepEqual(runtime.getResponsePolicy(), policy);
  assert.deepEqual(runtime.getHealth().responsePolicy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });
});

test('createRuntime treats shutdown response policy as the highest cumulative stage', () => {
  const runtime = createRuntime(createConfig());

  const policy = runtime.updateResponsePolicy({
    lockDirectoryPermissions: false,
    killSuspectProcesses: false,
    shutdownSystem: true
  });

  assert.deepEqual(policy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: true,
    shutdownSystem: true,
    quarantineScope: 'incident-target'
  });
});

test('createRuntime updates response policy quarantine scope', () => {
  const runtime = createRuntime(createConfig());

  const policy = runtime.updateResponsePolicy({
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'all-watch-targets'
  });

  assert.deepEqual(policy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'all-watch-targets'
  });
});

test('createRuntime updates demo file count settings', async () => {
  const runtime = createRuntime(createConfig());

  assert.equal(runtime.getDemoSettings().fileCount, 15);

  const settings = await runtime.updateDemoSettings({ fileCount: 9 });

  assert.deepEqual(settings, { fileCount: 9 });
  assert.equal(runtime.getSnapshot().demoSettings.fileCount, 9);
});

test('resetDemo clears current rule weights', async () => {
  const runtime = createRuntime(createConfig());
  const weightUpdates = [];
  runtime.eventBus.on(EVENT_NAMES.RULE_WEIGHT_UPDATED, (payload) => {
    weightUpdates.push(payload);
  });

  for (let index = 1; index <= 6; index += 1) {
    runtime.eventBus.emit(EVENT_NAMES.FS_EVENT, {
      id: `weight-before-reset-${index}`,
      type: 'modify',
      observedTs: 1000 + index,
      observedAt: new Date(1000 + index).toISOString(),
      path: `/tmp/watch/weight-before-reset-${index}.locked`,
      monitorTargetId: 'sandbox',
      monitorRootPath: '/tmp/configured-watch'
    });
  }

  assert.equal(weightUpdates.at(-1).currentWeight, 12);
  assert.equal(runtime.getSnapshot().health.rules.activeRuleWindows, 1);

  await runtime.resetDemo();

  assert.equal(weightUpdates.at(-1).eventType, 'reset');
  assert.equal(weightUpdates.at(-1).currentWeight, 0);
  assert.equal(runtime.getSnapshot().health.rules.activeRuleWindows, 0);

  runtime.eventBus.emit(EVENT_NAMES.FS_EVENT, {
    id: 'weight-after-reset',
    type: 'modify',
    observedTs: 2000,
    observedAt: new Date(2000).toISOString(),
    path: '/tmp/watch/weight-after-reset.locked',
    monitorTargetId: 'sandbox',
    monitorRootPath: '/tmp/configured-watch'
  });

  assert.equal(weightUpdates.at(-1).currentWeight, 2);

  await runtime.stop();
});


test('resetDemo pauses and restores active monitoring while preparing demo files', async () => {
  const auditdBackends = [];
  const runtime = createRuntime(createConfig(), {
    backendFactories: {
      auditd: createRuntimeBackendFactory('auditd', auditdBackends)
    }
  });
  const demoLogs = [];
  const healthStatuses = [];
  runtime.eventBus.on(EVENT_NAMES.DEMO_LOG, (payload) => {
    demoLogs.push(payload);
  });
  runtime.eventBus.on(EVENT_NAMES.SYSTEM_HEALTH, (payload) => {
    healthStatuses.push(payload.status);
  });

  await runtime.start();
  await runtime.resetDemo();

  assert.equal(auditdBackends[0].stopCalls, 1);
  assert.equal(auditdBackends.length, 2);
  assert.equal(auditdBackends[1].startCalls, 1);
  assert.deepEqual(demoLogs.map((entry) => entry.message), [
    '데모 파일 세팅을 위해 감시를 중지합니다.',
    '데모 파일 세팅이 끝나 감시를 다시 시작합니다.'
  ]);
  assert.ok(healthStatuses.includes('stopped'));
  assert.equal(runtime.getSnapshot().health.status, 'running');

  await runtime.stop();
});

test('resetDemo does not restart monitoring when watch is already stopped', async () => {
  const auditdBackends = [];
  const runtime = createRuntime(createConfig(), {
    backendFactories: {
      auditd: createRuntimeBackendFactory('auditd', auditdBackends)
    }
  });
  const demoLogs = [];
  runtime.eventBus.on(EVENT_NAMES.DEMO_LOG, (payload) => {
    demoLogs.push(payload);
  });

  await runtime.start();
  await runtime.stopWatch();
  await runtime.resetDemo();

  assert.equal(auditdBackends[0].stopCalls, 1);
  assert.equal(auditdBackends.length, 1);
  assert.equal(demoLogs.length, 0);
  assert.equal(runtime.getSnapshot().health.status, 'stopped');

  await runtime.stop();
});

test('createRuntime updates detection policy and persists it when configPath exists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-runtime-config-'));
  const configPath = path.join(tempDir, 'app-config.json');

  try {
    await fs.writeFile(configPath, JSON.stringify({
      server: {
        host: '127.0.0.1',
        port: 3000
      },
      detectionPolicy: {
        userAllowedExtensions: ['old']
      }
    }, null, 2));

    const config = createConfig();
    config.meta.configPath = configPath;
    const runtime = createRuntime(config);

    const policy = await runtime.updateDetectionPolicy({
      thresholdWeight: 12,
      weights: {
        knownExtension: 0.2,
        unknownExtension: 1.3,
        noExtension: 1.4,
        suspiciousExtension: 2.5
      },
      eventMultipliers: {
        create: 0.8,
        modify: 1.1,
        rename: 1.6
      },
      userAllowedExtensions: ['.backup', 'BACKUP'],
      suspiciousExtensions: ['locked']
    });

    assert.deepEqual(policy.userAllowedExtensions, ['backup']);
    assert.equal(policy.thresholdWeight, 12);
    assert.equal(runtime.getHealth().detectionPolicy.weights.knownExtension, 0.2);

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(persisted.detectionPolicy.thresholdWeight, 12);
    assert.deepEqual(persisted.detectionPolicy.userAllowedExtensions, ['backup']);
    assert.equal(persisted.detectionPolicy.eventMultipliers.rename, 1.6);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createRuntime resets detection policy to default and persists it', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-runtime-config-'));
  const configPath = path.join(tempDir, 'app-config.json');

  try {
    await fs.writeFile(configPath, JSON.stringify({
      detectionPolicy: {
        weights: {
          knownExtension: 0.9
        },
        userAllowedExtensions: ['custom']
      }
    }, null, 2));

    const config = createConfig();
    config.meta.configPath = configPath;
    config.detectionPolicy = {
      thresholdWeight: 20,
      weights: {
        knownExtension: 0.9
      },
      userAllowedExtensions: ['custom']
    };
    const runtime = createRuntime(config);

    const policy = await runtime.resetDetectionPolicy();

    assert.equal(policy.thresholdWeight, 10);
    assert.equal(policy.weights.knownExtension, 0.1);
    assert.deepEqual(policy.userAllowedExtensions, []);

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(persisted.detectionPolicy.thresholdWeight, 10);
    assert.equal(persisted.detectionPolicy.weights.knownExtension, 0.1);
    assert.deepEqual(persisted.detectionPolicy.userAllowedExtensions, []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime snapshot includes recursive file count for active watch target', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-watch-'));

  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'a');
    await fs.mkdir(path.join(rootPath, 'nested'));
    await fs.writeFile(path.join(rootPath, 'nested', 'b.txt'), 'b');

    const config = createConfig();
    config.monitor.targets[0].rootPath = rootPath;

    const runtime = createRuntime(config);
    const snapshot = runtime.getSnapshot();

    assert.equal(snapshot.watchedFileCount, 2);

    await runtime.stop();
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runtime snapshot sums recursive file counts across watch targets', async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-watch-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-watch-b-'));

  try {
    await fs.writeFile(path.join(firstRoot, 'a.txt'), 'a');
    await fs.mkdir(path.join(firstRoot, 'nested'));
    await fs.writeFile(path.join(firstRoot, 'nested', 'b.txt'), 'b');
    await fs.writeFile(path.join(secondRoot, 'c.txt'), 'c');

    const config = createConfig();
    config.monitor.targets = [
      { id: 'first', rootPath: firstRoot, enabled: true, autoQuarantineEnabled: false, demoAllowed: false },
      { id: 'second', rootPath: secondRoot, enabled: true, autoQuarantineEnabled: false, demoAllowed: false }
    ];

    const runtime = createRuntime(config);
    const snapshot = runtime.getSnapshot();

    assert.equal(snapshot.watchedFileCount, 3);
    assert.deepEqual(
      snapshot.targets.map((target) => target.rootPath),
      [firstRoot, secondRoot]
    );

    await runtime.stop();
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('runtime setTargetPaths persists monitor targets to config file', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-runtime-watch-config-'));
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-watch-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-watch-b-'));
  const configPath = path.join(tempDir, 'app-config.json');

  try {
    await fs.writeFile(configPath, JSON.stringify({
      monitor: {
        scriptPath: '../config/monitor.sh',
        restartDelayMs: 2000,
        movePairWindowMs: 750,
        targets: [
          {
            id: 'old',
            rootPath: '/tmp/old',
            enabled: true,
            autoQuarantineEnabled: false,
            demoAllowed: false
          }
        ]
      }
    }, null, 2));

    const config = createConfig();
    config.meta.configPath = configPath;
    const runtime = createRuntime(config);

    const snapshot = await runtime.setTargetPaths([firstRoot, secondRoot]);

    assert.deepEqual(
      snapshot.targets.map((target) => target.rootPath),
      [firstRoot, secondRoot]
    );

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(
      persisted.monitor.targets.map((target) => target.rootPath),
      [firstRoot, secondRoot]
    );
    assert.equal(persisted.monitor.targets[0].id, 'manual-1');
    assert.equal(persisted.monitor.scriptPath, '../config/monitor.sh');

    await runtime.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('startDemo runs worker child and republishes worker file events', async () => {
  const worker = createFakeDemoWorker();
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true },
    demoProcessFactory: () => worker
  });
  let fsEvent = null;

  runtime.eventBus.once(EVENT_NAMES.FS_EVENT, (event) => {
    fsEvent = event;
  });

  const snapshot = await runtime.startDemo();

  assert.equal(snapshot.demo.status, 'running');
  assert.equal(snapshot.demo.workerPid, worker.pid);

  worker.emit('message', {
    type: 'fs_event',
    payload: {
      eventType: 'modify',
      filePath: path.join(DEMO_TARGET_ROOT, 'file_1.txt')
    }
  });

  assert.equal(fsEvent.type, 'modify');
  assert.equal(fsEvent.path, path.join(DEMO_TARGET_ROOT, 'file_1.txt'));
  assert.equal(fsEvent.monitorRootPath, DEMO_TARGET_ROOT);
  assert.equal(fsEvent.pid, undefined);
  assert.equal(fsEvent.comm, undefined);
  assert.equal(fsEvent.source, 'demo-worker');
});

test('startDemo maps worker blocked message to DEMO_ABORTED details', async () => {
  const worker = createFakeDemoWorker();
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true },
    demoProcessFactory: () => worker
  });
  let aborted = null;

  runtime.eventBus.once(EVENT_NAMES.DEMO_ABORTED, (event) => {
    aborted = event;
  });

  await runtime.startDemo();
  worker.emit('message', {
    type: 'blocked',
    payload: {
      blockedPath: path.join(DEMO_TARGET_ROOT, 'file_4.txt'),
      blockedIndex: 4,
      errorCode: 'EACCES',
      errorMessage: 'permission denied',
      reason: 'Permission denied (EACCES) while writing file_4.txt'
    }
  });

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.demo.status, 'failed');
  assert.equal(snapshot.demo.lastError, 'Permission denied (EACCES) while writing file_4.txt');
  assert.equal(snapshot.demo.blockedPath, path.join(DEMO_TARGET_ROOT, 'file_4.txt'));
  assert.equal(snapshot.demo.blockedIndex, 4);
  assert.equal(snapshot.demo.errorCode, 'EACCES');
  assert.equal(aborted.blockedPath, path.join(DEMO_TARGET_ROOT, 'file_4.txt'));
});

test('startDemo reports killed demo processor when worker exits from signal', async () => {
  const worker = createFakeDemoWorker();
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true },
    demoProcessFactory: () => worker
  });
  let aborted = null;

  runtime.eventBus.once(EVENT_NAMES.DEMO_ABORTED, (event) => {
    aborted = event;
  });

  await runtime.startDemo();
  worker.emit('exit', null, 'SIGTERM');

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.demo.status, 'failed');
  assert.equal(snapshot.demo.lastError, 'Demo processor killed (SIGTERM)');
  assert.equal(aborted.lastError, 'Demo processor killed (SIGTERM)');
});

test('startDemo preserves active demo quarantine instead of resetting target permissions', async () => {
  const worker = createFakeDemoWorker();
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true },
    demoProcessFactory: () => worker
  });

  try {
    await clearDemoTarget();
    await fs.writeFile(path.join(DEMO_TARGET_ROOT, 'file_1.txt'), 'original content 1');

    const quarantineCompleted = waitForEvent(runtime.eventBus, EVENT_NAMES.QUARANTINE_COMPLETED);
    runtime.eventBus.emit(EVENT_NAMES.INCIDENT_OPENED, {
      id: 'incident-demo-quarantine',
      autoQuarantine: true,
      monitorTargetId: 'demo-target',
      monitorRootPath: DEMO_TARGET_ROOT,
      suspectProcesses: []
    });
    await quarantineCompleted;

    assert.equal((await fs.stat(DEMO_TARGET_ROOT)).mode & 0o777, 0);

    const snapshot = await runtime.startDemo();

    assert.equal(snapshot.demo.status, 'running');
    assert.equal((await fs.stat(DEMO_TARGET_ROOT)).mode & 0o777, 0);
  } finally {
    await runtime.stop();
    await clearDemoTarget();
  }
});

test('startAttack reports blocked when demo target permissions are locked', async () => {
  try {
    await clearDemoTarget();
    await fs.chmod(DEMO_TARGET_ROOT, 0o000);

    const result = await startAttack(null, { fileCount: 1 });

    assert.equal(result.status, 'blocked');
    assert.equal(result.errorCode, 'EACCES');
    assert.equal(result.blockedPath, path.join(DEMO_TARGET_ROOT, 'file_1.txt'));
  } finally {
    await clearDemoTarget();
  }
});

test('stopDemo sends abort to running worker', async () => {
  const worker = createFakeDemoWorker();
  const runtime = createRuntime(createConfig(), {
    watchOptions: { demo: true },
    demoProcessFactory: () => worker
  });

  await runtime.startDemo();
  const snapshot = await runtime.stopDemo();

  assert.equal(snapshot.demo.status, 'stopping');
  assert.deepEqual(worker.sentMessages, [{ type: 'abort' }]);

  worker.emit('message', { type: 'aborted', payload: { status: 'aborted' } });
  assert.equal(runtime.getSnapshot().demo.status, 'aborted');
});

async function clearDemoTarget() {
  await unlockDemoTarget();
  await fs.mkdir(DEMO_TARGET_ROOT, { recursive: true, mode: 0o755 });
  await fs.chmod(DEMO_TARGET_ROOT, 0o755).catch(() => {});

  const entries = await fs.readdir(DEMO_TARGET_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    await fs.rm(path.join(DEMO_TARGET_ROOT, entry.name), { recursive: true, force: true });
  }
}

async function unlockDemoTarget(rootPath = DEMO_TARGET_ROOT) {
  try {
    const stat = await fs.stat(rootPath);
    await fs.chmod(rootPath, stat.isDirectory() ? 0o755 : 0o644).catch(() => {});

    if (!stat.isDirectory()) {
      return;
    }

    const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await unlockDemoTarget(path.join(rootPath, entry.name));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function waitForEvent(eventBus, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventBus.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }

    eventBus.once(eventName, onEvent);
  });
}

function createFakeDemoWorker() {
  const worker = new EventEmitter();
  worker.pid = 4242;
  worker.stderr = new EventEmitter();
  worker.sentMessages = [];
  worker.killedSignals = [];
  worker.send = (message) => {
    worker.sentMessages.push(message);
  };
  worker.kill = (signal) => {
    worker.killedSignals.push(signal);
    worker.killed = true;
  };
  return worker;
}

function createRuntimeBackendFactory(name, store) {
  return ({ onHealth }) => {
    const backend = {
      startCalls: 0,
      stopCalls: 0,
      status: 'idle',
      async start() {
        this.startCalls += 1;
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
          pid: this.status === 'running' ? 4242 : null,
          lastEventAt: null,
          lastError: null,
          restartCount: 0
        };
      }
    };
    store.push(backend);
    return backend;
  };
}
