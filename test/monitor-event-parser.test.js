import test from 'node:test';
import assert from 'node:assert/strict';

import { MonitorEventNormalizer, parseMonitorLine } from '../src/collector/monitor-event-parser.js';

test('parseMonitorLine normalizes monitor output', () => {
  const parsed = parseMonitorLine('1710000000123\t/tmp/watch/file.txt\tMODIFY');

  assert.ok(parsed);
  assert.equal(parsed.rawType, 'modify');
  assert.equal(parsed.path, '/tmp/watch/file.txt');
  assert.equal(parsed.observedTs, 1710000000123);
});

test('parseMonitorLine keeps second-based timestamps compatible', () => {
  const parsed = parseMonitorLine('1710000000\t/tmp/watch/file.txt\tMODIFY');

  assert.ok(parsed);
  assert.equal(parsed.observedTs, 1710000000000);
});

test('MonitorEventNormalizer pairs move events into rename', () => {
  const normalizer = new MonitorEventNormalizer({
    targets: [{ id: 'sandbox', rootPath: '/tmp/watch' }],
    movePairWindowMs: 1000
  });

  const movedFrom = parseMonitorLine('1710000000\t/tmp/watch/before.txt\tMOVED_FROM');
  const movedTo = parseMonitorLine('1710000000\t/tmp/watch/after.txt\tMOVED_TO');

  assert.deepEqual(normalizer.consume(movedFrom), []);

  const [renameEvent] = normalizer.consume(movedTo);
  assert.equal(renameEvent.type, 'rename');
  assert.equal(renameEvent.previousPath, '/tmp/watch/before.txt');
  assert.equal(renameEvent.path, '/tmp/watch/after.txt');
  assert.equal(renameEvent.monitorTargetId, 'sandbox');
});

test('MonitorEventNormalizer pairs cross-directory moves inside the same target into rename', () => {
  const normalizer = new MonitorEventNormalizer({
    targets: [{ id: 'sandbox', rootPath: '/tmp/watch' }],
    movePairWindowMs: 1000
  });

  const movedFrom = parseMonitorLine('1710000000\t/tmp/watch/wed/test.txt\tMOVED_FROM');
  const movedTo = parseMonitorLine('1710000000\t/tmp/watch/test.txt\tMOVED_TO');

  assert.deepEqual(normalizer.consume(movedFrom), []);

  const [renameEvent] = normalizer.consume(movedTo);
  assert.equal(renameEvent.type, 'rename');
  assert.equal(renameEvent.previousPath, '/tmp/watch/wed/test.txt');
  assert.equal(renameEvent.path, '/tmp/watch/test.txt');
  assert.equal(renameEvent.monitorTargetId, 'sandbox');
});
