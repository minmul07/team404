import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/app/runtime.js';

const PROJECT_ROOT = process.cwd();
const DEMO_TARGET_ROOT = '/tmp/demo-target';

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
