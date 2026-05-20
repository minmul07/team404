import crypto from 'node:crypto';

import { EVENT_NAMES, FILE_EVENT_TYPES } from '../shared/contracts/event-names.js';
import { getExtensionWeight, loadExtensionWeights } from './extension-weight-loader.js';

const BURST_RULE_ID = 'extension-weight-burst';
const BURST_THRESHOLD = 10;
const BUCKET_MS = 1000;
const DETECTABLE_EVENT_TYPES = new Set([
  FILE_EVENT_TYPES.CREATE,
  FILE_EVENT_TYPES.MODIFY,
  FILE_EVENT_TYPES.RENAME
]);

export class RuleEngine {
  constructor({ eventBus, config }) {
    this.eventBus = eventBus;
    this.bucketsByTargetSecond = new Map();
    this.lastMatchAt = null;

    loadExtensionWeights(config.rules ?? {});

    this.handleFsEvent = this.handleFsEvent.bind(this);
    this.eventBus.on(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  getState() {
    return {
      activeRuleWindows: this.bucketsByTargetSecond.size,
      configuredRules: [
        {
          ruleId: BURST_RULE_ID,
          eventTypes: [...DETECTABLE_EVENT_TYPES],
          thresholdWeight: BURST_THRESHOLD,
          bucketMs: BUCKET_MS,
          severity: 'critical',
          autoQuarantine: true
        }
      ],
      lastMatchAt: this.lastMatchAt
    };
  }

  handleFsEvent(event) {
    if (!DETECTABLE_EVENT_TYPES.has(event.type)) {
      return;
    }

    const observedTs = Number.isFinite(event.observedTs) ? event.observedTs : Date.now();
    const bucketSecond = Math.floor(observedTs / BUCKET_MS);
    const targetKey = event.monitorTargetId ?? event.monitorRootPath ?? 'unknown';
    const bucketKey = `${targetKey}:${bucketSecond}`;
    const extension = parseExtension(event.path);
    const weight = getExtensionWeight(extension);
    const bucket = this.bucketsByTargetSecond.get(bucketKey) ?? createBucket(targetKey, bucketSecond);

    bucket.totalWeight += weight;
    bucket.events.push(event);
    bucket.extensions.push(extension);
    this.bucketsByTargetSecond.set(bucketKey, bucket);
    this.cleanupOldBuckets(targetKey, bucketSecond);

    if (bucket.totalWeight <= BURST_THRESHOLD) {
      return;
    }

    const samplePaths = [...new Set(bucket.events.map((item) => item.path))].slice(0, 10);
    const eventTypes = [...new Set(bucket.events.map((item) => item.type))];
    const match = {
      id: crypto.randomUUID(),
      ruleId: BURST_RULE_ID,
      ruleName: 'Extension Weight Burst',
      eventType: event.type,
      severity: 'critical',
      autoQuarantine: true,
      reason: `extension weights reached ${formatWeight(bucket.totalWeight)}>${BURST_THRESHOLD} in 1s`,
      observedAt: event.observedAt,
      observedTs,
      monitorTargetId: event.monitorTargetId,
      monitorRootPath: event.monitorRootPath,
      bucketSecond,
      bucketMs: BUCKET_MS,
      thresholdWeight: BURST_THRESHOLD,
      totalWeight: bucket.totalWeight,
      eventCount: bucket.events.length,
      samplePaths,
      targetPaths: samplePaths,
      eventTypes
    };

    this.lastMatchAt = event.observedAt;
    this.eventBus.emit(EVENT_NAMES.RULE_MATCH, match);
  }

  cleanupOldBuckets(targetKey, currentBucketSecond) {
    for (const [bucketKey, bucket] of this.bucketsByTargetSecond) {
      if (bucket.targetKey === targetKey && bucket.bucketSecond < currentBucketSecond - 1) {
        this.bucketsByTargetSecond.delete(bucketKey);
      }
    }
  }
}

function createBucket(targetKey, bucketSecond) {
  return {
    targetKey,
    bucketSecond,
    totalWeight: 0,
    events: [],
    extensions: []
  };
}

function parseExtension(filePath) {
  if (typeof filePath !== 'string') {
    return '';
  }

  const fileName = filePath.split('/').pop() ?? '';
  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return '';
  }

  return fileName.slice(lastDotIndex + 1).toLowerCase();
}

function formatWeight(weight) {
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(2);
}
