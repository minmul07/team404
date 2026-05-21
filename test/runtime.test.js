import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/app/runtime.js';
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
  assert.deepEqual(runtime.getHealth().responsePolicy, policy);
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
