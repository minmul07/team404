import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/app/runtime.js';

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
    shutdownSystem: false
  });

  assert.deepEqual(runtime.getSnapshot().responsePolicy, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false
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
    shutdownSystem: false
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
    shutdownSystem: true
  });
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
    assert.equal(runtime.getHealth().detectionPolicy.weights.knownExtension, 0.2);

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
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
      weights: {
        knownExtension: 0.9
      },
      userAllowedExtensions: ['custom']
    };
    const runtime = createRuntime(config);

    const policy = await runtime.resetDetectionPolicy();

    assert.equal(policy.weights.knownExtension, 0.1);
    assert.deepEqual(policy.userAllowedExtensions, []);

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
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
