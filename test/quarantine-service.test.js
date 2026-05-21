import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { QuarantineService } from '../src/isolation/quarantine-service.js';
import { EVENT_NAMES } from '../src/shared/contracts/event-names.js';
import { createEventBus } from '../src/shared/utils/create-event-bus.js';

test('QuarantineService does not use mount-wide fuser cleanup', async () => {
  const source = await fs.readFile(
    path.resolve('src/isolation/quarantine-service.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /\bfuser\s+-m\b/);
});


test('QuarantineService kill stage terminates suspect process metadata without killing current server', async () => {
  const eventBus = createEventBus();
  const killed = [];
  const service = new QuarantineService({
    eventBus,
    getResponsePolicy: () => ({
      lockDirectoryPermissions: false,
      killSuspectProcesses: true,
      shutdownSystem: false,
      quarantineScope: 'incident-target'
    }),
    getWatchTargets: () => [],
    processKiller: (pid, signal) => {
      killed.push({ pid, signal });
    }
  });

  await service.handleIncidentOpened({
    id: 'incident-1',
    autoQuarantine: true,
    monitorRootPath: '/tmp/demo-target',
    suspectProcesses: [
      { pid: process.pid, path: '/tmp/demo-target/file_1.txt' },
      { pid: 4242, path: '/tmp/demo-target/file_2.txt', comm: 'team404-demo-worker' }
    ]
  });

  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGTERM' }]);
  service.stop();
});

test('QuarantineService ignores suspect process metadata outside demo-target safety scope', async () => {
  const eventBus = createEventBus();
  const killed = [];
  const service = new QuarantineService({
    eventBus,
    getResponsePolicy: () => ({
      lockDirectoryPermissions: false,
      killSuspectProcesses: true,
      shutdownSystem: false,
      quarantineScope: 'incident-target'
    }),
    processKiller: (pid, signal) => {
      killed.push({ pid, signal });
    }
  });

  await service.handleIncidentOpened({
    id: 'incident-2',
    autoQuarantine: true,
    monitorRootPath: '/tmp/not-demo',
    suspectProcesses: [
      { pid: 4242, path: '/tmp/not-demo/file.txt' }
    ]
  });

  assert.deepEqual(killed, []);
  service.stop();
});
