import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createRuntime } from '../src/app/runtime.js';

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
  assert.equal(health.activeMode, 'demo');
  assert.equal(health.activeTarget.id, 'demo-target');
  assert.equal(health.activeTarget.rootPath, DEMO_TARGET_ROOT);
});
