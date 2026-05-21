import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { loadAppConfig } from '../src/shared/config/load-app-config.js';

test('loadAppConfig keeps configured monitor targets without runtime mode overrides', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'team404-config-'));

  try {
    const configPath = await writeConfig(tempDir, {
      monitor: {
        scriptPath: '../config/monitor.sh',
        restartDelayMs: 1000,
        movePairWindowMs: 500,
        targets: [{ id: 'input-target', rootPath: './configured-watch' }]
      },
      rules: [
        {
          ruleId: 'burst-create',
          eventType: 'create'
        }
      ]
    });

    const config = await loadAppConfig({ configPath });

    assert.equal(config.monitor.targets.length, 1);
    assert.equal(config.monitor.targets[0].id, 'input-target');
    assert.equal(
      config.monitor.targets[0].rootPath,
      path.join(tempDir, 'configured-watch')
    );
    assert.equal(config.rules.definitions[0].ruleId, 'burst-create');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadAppConfig keeps rule arrays without legacy threshold normalization', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'team404-config-'));

  try {
    const configPath = await writeConfig(tempDir, {
      monitor: {
        scriptPath: '../config/monitor.sh',
        restartDelayMs: 1000,
        movePairWindowMs: 500,
        targets: [{ id: 'input-target', rootPath: './configured-watch' }]
      },
      rules: {
        severity: 'critical',
        autoQuarantine: true
      }
    });

    const config = await loadAppConfig({ configPath });

    assert.deepEqual(config.rules.definitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadAppConfig normalizes detection policy settings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'team404-config-'));

  try {
    const configPath = await writeConfig(tempDir, {
      monitor: {
        scriptPath: '../config/monitor.sh',
        restartDelayMs: 1000,
        movePairWindowMs: 500,
        targets: [{ id: 'input-target', rootPath: './configured-watch' }]
      },
      detectionPolicy: {
        thresholdWeight: 14,
        weights: {
          knownExtension: 0.2,
          unknownExtension: 1.4,
          noExtension: 1.8,
          suspiciousExtension: 2.6
        },
        eventMultipliers: {
          create: 0.9,
          modify: 1.1,
          rename: 1.7
        },
        weightDecay: {
          intervalMs: 750,
          amount: 0.75
        },
        userAllowedExtensions: ['.backup', 'BACKUP', 'log'],
        suspiciousExtensions: ['LOCKED']
      }
    });

    const config = await loadAppConfig({ configPath });

    assert.equal(config.detectionPolicy.thresholdWeight, 14);
    assert.equal(config.detectionPolicy.weights.unknownExtension, 1.4);
    assert.equal(config.detectionPolicy.eventMultipliers.rename, 1.7);
    assert.equal(config.detectionPolicy.weightDecay.intervalMs, 750);
    assert.equal(config.detectionPolicy.weightDecay.amount, 0.75);
    assert.deepEqual(config.detectionPolicy.userAllowedExtensions, ['backup', 'log']);
    assert.deepEqual(config.detectionPolicy.suspiciousExtensions, ['locked']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writeConfig(tempDir, overrides) {
  const configPath = path.join(tempDir, 'app-config.json');
  const payload = {
    server: {
      host: '127.0.0.1',
      port: 3000
    },
    ...overrides
  };

  await writeFile(configPath, JSON.stringify(payload, null, 2));
  return configPath;
}
