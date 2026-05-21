import crypto from 'node:crypto';
import path from 'node:path';

import { FILE_EVENT_TYPES } from '../shared/contracts/event-names.js';

const RAW_EVENT_ORDER = ['MOVED_FROM', 'MOVED_TO', 'CREATE', 'MODIFY', 'DELETE'];
const DEFAULT_AUDIT_KEY = 'team404_watch';
const DEFAULT_AUDIT_EVENT_TIMEOUT_MS = 1000;
const RENAME_SYSCALLS = new Set(['rename', 'renameat', 'renameat2', '82', '264', '316']);
const DELETE_SYSCALLS = new Set(['unlink', 'unlinkat', 'rmdir', '87', '263', '84']);
const CREATE_SYSCALLS = new Set(['creat', 'mkdir', 'mkdirat', 'mknod', 'mknodat', '85', '83', '258', '133', '259']);

export function parseMonitorLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const [timestampRaw, filePath, rawEvents] = trimmed.split('\t');
  if (!timestampRaw || !filePath || !rawEvents) {
    return null;
  }

  const observedTs = parseObservedTimestamp(timestampRaw);
  if (observedTs === null) {
    return null;
  }

  const tokens = rawEvents
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);

  const rawType = RAW_EVENT_ORDER.find((token) => tokens.includes(token));
  if (!rawType) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    observedTs,
    observedAt: new Date(observedTs).toISOString(),
    path: filePath,
    rawEvents: tokens,
    rawType: normalizeRawType(rawType)
  };
}

export function parseAuditdRecord(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^type=([^\s]+)\s+msg=audit\((\d+(?:\.\d+)?):(\d+)\):\s*(.*)$/);
  if (!match) {
    return null;
  }

  const [, type, timestampRaw, auditId, fieldsRaw] = match;
  const observedTs = parseObservedTimestamp(timestampRaw);
  if (observedTs === null) {
    return null;
  }

  return {
    type,
    auditId,
    eventKey: `${timestampRaw}:${auditId}`,
    observedTs,
    observedAt: new Date(observedTs).toISOString(),
    fields: parseAuditdFields(fieldsRaw),
    raw: trimmed
  };
}

export class MonitorEventNormalizer {
  constructor({ targets, movePairWindowMs }) {
    this.targets = sortTargets(targets);
    this.movePairWindowMs = movePairWindowMs;
    this.pendingMoves = [];
  }

  consume(rawEvent) {
    const emitted = this.flushExpired(rawEvent.observedTs);

    switch (rawEvent.rawType) {
      case 'moved_from':
        this.pendingMoves.push(rawEvent);
        return emitted;
      case 'moved_to': {
        const match = this.findMoveMatch(rawEvent);
        if (match) {
          emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.RENAME, rawEvent, match.path));
        } else {
          emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.CREATE, rawEvent));
        }
        return emitted;
      }
      case 'create':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.CREATE, rawEvent));
        return emitted;
      case 'modify':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.MODIFY, rawEvent));
        return emitted;
      case 'delete':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.DELETE, rawEvent));
        return emitted;
      default:
        return emitted;
    }
  }

  flushAll() {
    const emitted = this.pendingMoves.map((pending) =>
      this.toCanonicalEvent(FILE_EVENT_TYPES.DELETE, pending)
    );
    this.pendingMoves = [];
    return emitted;
  }

  flushExpired(nowTs) {
    const keep = [];
    const emitted = [];

    for (const pending of this.pendingMoves) {
      if (nowTs - pending.observedTs > this.movePairWindowMs) {
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.DELETE, pending));
      } else {
        keep.push(pending);
      }
    }

    this.pendingMoves = keep;
    return emitted;
  }

  // target 디렉토리 간 이동: delete + create
  // 동일 target 내 디렉토리 간 이동: rename
  findMoveMatch(rawEvent) {
    const nextTarget = resolveTarget(rawEvent.path, this.targets);
    const index = this.pendingMoves.findIndex((pending) => {
      const withinWindow = rawEvent.observedTs - pending.observedTs <= this.movePairWindowMs;
      if (!withinWindow || !nextTarget) {
        return false;
      }

      const pendingTarget = resolveTarget(pending.path, this.targets);
      return pendingTarget?.rootPath === nextTarget.rootPath;
    });

    if (index === -1) {
      return null;
    }

    const [match] = this.pendingMoves.splice(index, 1);
    return match;
  }

  toCanonicalEvent(type, rawEvent, previousPath) {
    const target = resolveTarget(rawEvent.path, this.targets);

    return {
      id: rawEvent.id,
      type,
      observedTs: rawEvent.observedTs,
      observedAt: rawEvent.observedAt,
      path: rawEvent.path,
      previousPath,
      monitorTargetId: target?.id ?? null,
      monitorRootPath: target?.rootPath ?? null,
      rawEvents: rawEvent.rawEvents,
      source: 'inotify'
    };
  }
}

export class AuditdEventNormalizer {
  constructor({ targets, auditKey = DEFAULT_AUDIT_KEY, eventTimeoutMs = DEFAULT_AUDIT_EVENT_TIMEOUT_MS }) {
    this.targets = sortTargets(targets);
    this.auditKey = auditKey;
    this.eventTimeoutMs = eventTimeoutMs;
    this.pending = new Map();
    this.lastEventKey = null;
  }

  consumeLine(line) {
    const record = parseAuditdRecord(line);
    if (!record) {
      return [];
    }

    return this.consumeRecord(record);
  }

  consumeRecord(record) {
    const emitted = this.flushExpired(record.observedTs);

    if (this.lastEventKey && this.lastEventKey !== record.eventKey) {
      emitted.push(...this.finalizeEvent(this.lastEventKey));
    }

    this.lastEventKey = record.eventKey;
    const entry = this.pending.get(record.eventKey) ?? {
      eventKey: record.eventKey,
      auditId: record.auditId,
      observedTs: record.observedTs,
      observedAt: record.observedAt,
      records: []
    };
    entry.records.push(record);
    this.pending.set(record.eventKey, entry);

    return emitted;
  }

  flushExpired(nowTs) {
    const emitted = [];

    for (const [eventKey, entry] of this.pending.entries()) {
      if (eventKey !== this.lastEventKey && nowTs - entry.observedTs > this.eventTimeoutMs) {
        emitted.push(...this.finalizeEvent(eventKey));
      }
    }

    return emitted;
  }

  flushAll() {
    const emitted = [];

    for (const eventKey of [...this.pending.keys()]) {
      emitted.push(...this.finalizeEvent(eventKey));
    }

    this.lastEventKey = null;
    return emitted;
  }

  finalizeEvent(eventKey) {
    const entry = this.pending.get(eventKey);
    if (!entry) {
      return [];
    }

    this.pending.delete(eventKey);
    if (this.lastEventKey === eventKey) {
      this.lastEventKey = null;
    }

    const event = this.toCanonicalEvent(entry);
    return event ? [event] : [];
  }

  toCanonicalEvent(entry) {
    const syscall = entry.records.find((record) => record.type === 'SYSCALL');
    const paths = entry.records.filter((record) => record.type === 'PATH');
    const cwd = entry.records.find((record) => record.type === 'CWD');
    const proctitle = entry.records.find((record) => record.type === 'PROCTITLE');

    if (!syscall || paths.length === 0 || syscall.fields.success !== 'yes') {
      return null;
    }

    if (!entry.records.some((record) => record.fields.key === this.auditKey)) {
      return null;
    }

    const type = inferAuditdEventType(syscall.fields.syscall, paths);
    if (!type) {
      return null;
    }

    const selectedPath = selectAuditPath(type, paths);
    if (!selectedPath) {
      return null;
    }

    const previousPath = type === FILE_EVENT_TYPES.RENAME
      ? selectPathByNametype(paths, 'DELETE')?.fields.name
      : undefined;
    const target = resolveTarget(selectedPath, this.targets);

    return {
      id: crypto.randomUUID(),
      type,
      observedTs: entry.observedTs,
      observedAt: entry.observedAt,
      path: selectedPath,
      previousPath,
      monitorTargetId: target?.id ?? null,
      monitorRootPath: target?.rootPath ?? null,
      rawEvents: entry.records.map((record) => record.type),
      source: 'auditd',
      auditEventId: entry.auditId,
      pid: parseOptionalInteger(syscall.fields.pid),
      ppid: parseOptionalInteger(syscall.fields.ppid),
      uid: parseOptionalInteger(syscall.fields.uid),
      auid: parseOptionalInteger(syscall.fields.auid),
      comm: syscall.fields.comm ?? null,
      exe: syscall.fields.exe ?? null,
      cwd: cwd?.fields.cwd ?? null,
      proctitle: decodeProctitle(proctitle?.fields.proctitle)
    };
  }
}

function inferAuditdEventType(syscallRaw, paths) {
  const syscall = String(syscallRaw ?? '').toLowerCase();
  const nameTypes = new Set(paths.map((record) => String(record.fields.nametype ?? '').toUpperCase()));

  if (RENAME_SYSCALLS.has(syscall) || (nameTypes.has('DELETE') && nameTypes.has('CREATE'))) {
    return FILE_EVENT_TYPES.RENAME;
  }

  if (DELETE_SYSCALLS.has(syscall) || nameTypes.has('DELETE')) {
    return FILE_EVENT_TYPES.DELETE;
  }

  if (CREATE_SYSCALLS.has(syscall) || nameTypes.has('CREATE')) {
    return FILE_EVENT_TYPES.CREATE;
  }

  if (nameTypes.has('NORMAL') || nameTypes.has('PARENT')) {
    return FILE_EVENT_TYPES.MODIFY;
  }

  return null;
}

function selectAuditPath(type, paths) {
  if (type === FILE_EVENT_TYPES.RENAME) {
    return selectPathByNametype(paths, 'CREATE')?.fields.name ?? selectNamedPath(paths)?.fields.name ?? null;
  }

  if (type === FILE_EVENT_TYPES.DELETE) {
    return selectPathByNametype(paths, 'DELETE')?.fields.name ?? selectNamedPath(paths)?.fields.name ?? null;
  }

  if (type === FILE_EVENT_TYPES.CREATE) {
    return selectPathByNametype(paths, 'CREATE')?.fields.name ?? selectNamedPath(paths)?.fields.name ?? null;
  }

  return selectPathByNametype(paths, 'NORMAL')?.fields.name ?? selectNamedPath(paths)?.fields.name ?? null;
}

function selectPathByNametype(paths, nametype) {
  return paths.find((record) => String(record.fields.nametype ?? '').toUpperCase() === nametype && isConcreteAuditPath(record.fields.name));
}

function selectNamedPath(paths) {
  return paths.find((record) => isConcreteAuditPath(record.fields.name));
}

function isConcreteAuditPath(value) {
  return Boolean(value && value !== '(null)' && value !== '');
}

function normalizeRawType(rawType) {
  return rawType.toLowerCase();
}

function parseObservedTimestamp(timestampRaw) {
  const numeric = Number(timestampRaw);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (timestampRaw.includes('.')) {
    return Math.round(numeric * 1000);
  }

  if (numeric >= 1_000_000_000_000) {
    return Math.trunc(numeric);
  }

  return Math.trunc(numeric * 1000);
}

function parseAuditdFields(raw) {
  const fields = {};
  const pattern = /(\w+)=((?:"(?:\\.|[^"])*")|(?:\S+))/g;
  let match;

  while ((match = pattern.exec(raw)) !== null) {
    fields[match[1]] = unquoteAuditValue(match[2]);
  }

  return fields;
}

function unquoteAuditValue(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  return value;
}

function parseOptionalInteger(value) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) ? numberValue : null;
}

function decodeProctitle(value) {
  if (!value) {
    return null;
  }

  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      return Buffer.from(value, 'hex').toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      return value;
    }
  }

  return value;
}

function sortTargets(targets) {
  return [...targets].sort((left, right) => right.rootPath.length - left.rootPath.length);
}

function resolveTarget(eventPath, targets) {
  return targets.find((target) => {
    const relative = path.relative(target.rootPath, eventPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
