import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/app/runtime.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FAKE_MONITOR_SCRIPT = '/tmp/fake-monitor.sh';

async function setupFakeMonitorScript() {
  await fs.writeFile(
    FAKE_MONITOR_SCRIPT,
    '#!/usr/bin/env bash\nwhile true; do sleep 1; done\n',
    { mode: 0o755 }
  );
}

function createTestConfig(targetPath) {
  return {
    monitor: {
      scriptPath: FAKE_MONITOR_SCRIPT,
      restartDelayMs: 1000,
      movePairWindowMs: 500,
      targets: [
        {
          id: 'integration-test-target',
          rootPath: targetPath,
          enabled: true,
          autoQuarantineEnabled: true,
          demoAllowed: false
        }
      ]
    },
    rules: {
      definitions: []
    },
    meta: {
      projectRoot: PROJECT_ROOT
    }
  };
}

function waitForEvent(eventBus, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeoutMs);
    eventBus.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('integration: detection-to-quarantine-to-restore flow', async () => {
  await setupFakeMonitorScript();

  const tempDir = await fs.mkdtemp(path.join('/tmp', 'team404-integration-'));
  await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'file1.txt'), 'hello');
  await fs.writeFile(path.join(tempDir, 'subdir', 'file2.txt'), 'world');
  await fs.writeFile(
    path.join(tempDir, 'subdir', 'secret.txt.demo.locked'),
    Buffer.from('secret payload').toString('base64')
  );

  const runtime = createRuntime(createTestConfig(tempDir));

  const captured = {
    ruleMatch: null,
    incidentOpened: null,
    quarantineStarted: null,
    quarantineCompleted: null,
    restoreCompleted: null
  };

  runtime.eventBus.on(EVENT_NAMES.RULE_MATCH, (e) => { captured.ruleMatch = e; });
  runtime.eventBus.on(EVENT_NAMES.INCIDENT_OPENED, (e) => { captured.incidentOpened = e; });
  runtime.eventBus.on(EVENT_NAMES.QUARANTINE_STARTED, (e) => { captured.quarantineStarted = e; });
  runtime.eventBus.on(EVENT_NAMES.QUARANTINE_COMPLETED, (e) => { captured.quarantineCompleted = e; });
  runtime.eventBus.on(EVENT_NAMES.RESTORE_COMPLETED, (e) => { captured.restoreCompleted = e; });

  try {
    await runtime.start();

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    for (let i = 0; i < 11; i++) {
      runtime.eventBus.emit(EVENT_NAMES.FS_EVENT, {
        type: 'modify',
        path: path.join(tempDir, `file${i}.unknownext`),
        observedAt: nowIso,
        observedTs: now,
        monitorTargetId: 'integration-test-target',
        monitorRootPath: tempDir
      });
    }

    await waitForEvent(runtime.eventBus, EVENT_NAMES.QUARANTINE_COMPLETED, 5000);

    assert.ok(captured.ruleMatch, 'RULE_MATCH should be emitted');
    assert.ok(captured.incidentOpened, 'INCIDENT_OPENED should be emitted');
    assert.ok(captured.quarantineStarted, 'QUARANTINE_STARTED should be emitted');
    assert.ok(captured.quarantineCompleted, 'QUARANTINE_COMPLETED should be emitted');
    assert.equal(captured.quarantineCompleted.entryCount, 3);
    assert.equal(captured.quarantineCompleted.permissionEntryCount, 5);

    const incident = runtime.incidentStore.getIncidents().find(i => i.id === captured.incidentOpened.id);
    assert.ok(incident, 'Incident should exist in store');
    assert.equal(incident.status, 'quarantined', 'Incident status should be quarantined');

    const restoreResult = await runtime.restoreIncident(incident.id);

    assert.ok(captured.restoreCompleted, 'RESTORE_COMPLETED should be emitted');
    assert.equal(restoreResult.entryCount, 3);
    assert.equal(restoreResult.permissionEntryCount, 5);
    assert.equal(restoreResult.decryptedFileCount, 0);
    assert.equal(
      await fs.readFile(path.join(tempDir, 'subdir', 'secret.txt.demo.locked'), 'utf8'),
      Buffer.from('secret payload').toString('base64')
    );
    await assert.rejects(fs.access(path.join(tempDir, 'subdir', 'secret.txt')));

    const restoredIncident = runtime.incidentStore.getIncidents().find(i => i.id === incident.id);
    assert.equal(restoredIncident.status, 'restored', 'Incident status should be restored');

  } finally {
    await runtime.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
