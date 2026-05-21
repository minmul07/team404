import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditdEventNormalizer, MonitorEventNormalizer, parseMonitorLine } from '../src/collector/monitor-event-parser.js';

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


test('AuditdEventNormalizer extracts pid metadata and create event from raw records', () => {
  const normalizer = new AuditdEventNormalizer({
    targets: [{ id: 'sandbox', rootPath: '/tmp/watch' }],
    auditKey: 'team404_watch'
  });

  const lines = [
    'type=SYSCALL msg=audit(1710000000.123:77): arch=c000003e syscall=85 success=yes exit=3 pid=4321 ppid=1 auid=1000 uid=1000 comm="touch" exe="/usr/bin/touch" key="team404_watch"',
    'type=CWD msg=audit(1710000000.123:77): cwd="/tmp/watch"',
    'type=PATH msg=audit(1710000000.123:77): item=0 name="/tmp/watch/new.txt" inode=1 nametype=CREATE key="team404_watch"',
    'type=PROCTITLE msg=audit(1710000000.123:77): proctitle=746F756368002F746D702F77617463682F6E65772E747874'
  ];

  for (const line of lines) {
    assert.deepEqual(normalizer.consumeLine(line), []);
  }

  const [event] = normalizer.flushAll();
  assert.equal(event.type, 'create');
  assert.equal(event.path, '/tmp/watch/new.txt');
  assert.equal(event.monitorTargetId, 'sandbox');
  assert.equal(event.pid, 4321);
  assert.equal(event.ppid, 1);
  assert.equal(event.uid, 1000);
  assert.equal(event.auid, 1000);
  assert.equal(event.comm, 'touch');
  assert.equal(event.exe, '/usr/bin/touch');
  assert.equal(event.cwd, '/tmp/watch');
  assert.equal(event.source, 'auditd');
});

test('AuditdEventNormalizer drops incomplete audit events on flush', () => {
  const normalizer = new AuditdEventNormalizer({
    targets: [{ id: 'sandbox', rootPath: '/tmp/watch' }],
    auditKey: 'team404_watch'
  });

  normalizer.consumeLine('type=SYSCALL msg=audit(1710000000.123:78): arch=c000003e syscall=85 success=yes exit=3 pid=4321 comm="touch" exe="/usr/bin/touch" key="team404_watch"');

  assert.deepEqual(normalizer.flushAll(), []);
});

test('AuditdEventNormalizer maps rename from delete/create path records', () => {
  const normalizer = new AuditdEventNormalizer({
    targets: [{ id: 'sandbox', rootPath: '/tmp/watch' }],
    auditKey: 'team404_watch'
  });

  const lines = [
    'type=SYSCALL msg=audit(1710000000.123:79): arch=c000003e syscall=82 success=yes exit=0 pid=111 comm="mv" exe="/usr/bin/mv" key="team404_watch"',
    'type=PATH msg=audit(1710000000.123:79): item=0 name="/tmp/watch/before.txt" nametype=DELETE key="team404_watch"',
    'type=PATH msg=audit(1710000000.123:79): item=1 name="/tmp/watch/after.txt" nametype=CREATE key="team404_watch"'
  ];

  for (const line of lines) {
    normalizer.consumeLine(line);
  }

  const [event] = normalizer.flushAll();
  assert.equal(event.type, 'rename');
  assert.equal(event.previousPath, '/tmp/watch/before.txt');
  assert.equal(event.path, '/tmp/watch/after.txt');
});
