import crypto from 'node:crypto';
import path from 'node:path';

import { FILE_EVENT_TYPES } from '../shared/contracts/event-names.js';

const RAW_EVENT_ORDER = ['MOVED_FROM', 'MOVED_TO', 'CREATE', 'MODIFY', 'DELETE'];

export function parseMonitorLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const [timestampRaw, filePath, rawEvents] = trimmed.split('\t');
  if (!timestampRaw || !filePath || !rawEvents) {
    return null;
  }

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) {
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
    observedTs: timestampSeconds * 1000,
    observedAt: new Date(timestampSeconds * 1000).toISOString(),
    path: filePath,
    rawEvents: tokens,
    rawType: normalizeRawType(rawType)
  };
}

export class MonitorEventNormalizer {
  constructor({ targets, movePairWindowMs }) {
    this.targets = [...targets].sort((left, right) => right.rootPath.length - left.rootPath.length);
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
      rawEvents: rawEvent.rawEvents
    };
  }
}

function normalizeRawType(rawType) {
  return rawType.toLowerCase();
}

function resolveTarget(eventPath, targets) {
  return targets.find((target) => {
    const relative = path.relative(target.rootPath, eventPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
