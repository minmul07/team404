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
          eventType: 'create',
          threshold: 2,
          windowMs: 3000,
          incidentCooldownMs: 4000
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

test('loadAppConfig normalizes legacy burst settings into create/modify/delete rule definitions', async () => {
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
        burstWindowMs: 3000,
        burstThreshold: 4,
        incidentCooldownMs: 5000,
        severity: 'critical',
        autoQuarantine: true
      }
    });

    const config = await loadAppConfig({ configPath });

    assert.deepEqual(
      config.rules.definitions.map((rule) => rule.eventType),
      ['create', 'modify', 'delete']
    );
    for (const rule of config.rules.definitions) {
      assert.equal(rule.threshold, 4);
      assert.equal(rule.windowMs, 3000);
      assert.equal(rule.incidentCooldownMs, 5000);
      assert.equal(rule.severity, 'critical');
      assert.equal(rule.autoQuarantine, true);
    }
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
