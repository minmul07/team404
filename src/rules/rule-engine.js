import crypto from 'node:crypto';

import { EVENT_NAMES, FILE_EVENT_TYPES } from '../shared/contracts/event-names.js';
import { getEventMultiplier, getExtensionWeight, loadExtensionWeights } from './extension-weight-loader.js';

const BURST_RULE_ID = 'extension-weight-burst';
const BUCKET_MS = 1000;
const DETECTABLE_EVENT_TYPES = new Set([
  FILE_EVENT_TYPES.CREATE,
  FILE_EVENT_TYPES.MODIFY,
  FILE_EVENT_TYPES.RENAME
]);

export class RuleEngine {
  constructor({ eventBus, config }) {
    this.eventBus = eventBus;
    this.config = config;
    this.bucketsByTargetSecond = new Map();
    this.lastMatchAt = null;
    this.activeRuleSettings = null;
    this.decayTimer = null;

    this.updateDetectionPolicy(config.detectionPolicy);

    this.handleFsEvent = this.handleFsEvent.bind(this);
    this.eventBus.on(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
    this.stopDecayTimer();
  }

  getState() {
    const thresholdWeight = this.getThresholdWeight();
    return {
      activeRuleWindows: this.bucketsByTargetSecond.size,
      detectionPolicy: this.activeRuleSettings?.detectionPolicy ?? null,
      configuredRules: [
        {
          ruleId: BURST_RULE_ID,
          eventTypes: [...DETECTABLE_EVENT_TYPES],
          thresholdWeight,
          weightDecay: this.getWeightDecay(),
          bucketMs: BUCKET_MS,
          severity: 'critical',
          autoQuarantine: true
        }
      ],
      lastMatchAt: this.lastMatchAt
    };
  }

  updateDetectionPolicy(detectionPolicy) {
    this.activeRuleSettings = loadExtensionWeights({
      detectionPolicy,
      customExtensionWeights: this.config.customExtensionWeights
    });
    this.restartDecayTimer();
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
    const weight = getExtensionWeight(extension) * getEventMultiplier(event.type);
    const bucket = this.bucketsByTargetSecond.get(bucketKey) ?? createBucket(targetKey, bucketSecond);
    const thresholdWeight = this.getThresholdWeight();

    bucket.totalWeight += weight;
    bucket.events.push(event);
    bucket.extensions.push(extension);
    bucket.lastEvent = event;
    bucket.lastEventWeight = weight;
    this.bucketsByTargetSecond.set(bucketKey, bucket);
    this.cleanupOldBuckets(targetKey, bucketSecond);

    this.eventBus.emit(EVENT_NAMES.RULE_WEIGHT_UPDATED, {
      ruleId: BURST_RULE_ID,
      ruleName: 'Extension Weight Burst',
      monitorTargetId: event.monitorTargetId,
      monitorRootPath: event.monitorRootPath,
      path: event.path,
      eventType: event.type,
      eventWeight: weight,
      currentWeight: bucket.totalWeight,
      thresholdWeight,
      eventCount: bucket.events.length,
      bucketSecond,
      bucketMs: BUCKET_MS,
      observedAt: event.observedAt,
      observedTs
    });

    if (bucket.totalWeight <= thresholdWeight) {
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
      reason: `extension weights reached ${formatWeight(bucket.totalWeight)}>${formatWeight(thresholdWeight)} in 1s`,
      observedAt: event.observedAt,
      observedTs,
      monitorTargetId: event.monitorTargetId,
      monitorRootPath: event.monitorRootPath,
      bucketSecond,
      bucketMs: BUCKET_MS,
      thresholdWeight,
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

  getThresholdWeight() {
    return this.activeRuleSettings?.detectionPolicy?.thresholdWeight ?? 10;
  }

  getWeightDecay() {
    return this.activeRuleSettings?.detectionPolicy?.weightDecay ?? {
      intervalMs: 1000,
      amount: 1
    };
  }

  restartDecayTimer() {
    this.stopDecayTimer();

    const decay = this.getWeightDecay();
    if (!Number.isFinite(decay.amount) || decay.amount <= 0) {
      return;
    }

    this.decayTimer = setInterval(() => {
      this.applyWeightDecay();
    }, decay.intervalMs);
    this.decayTimer.unref?.();
  }

  stopDecayTimer() {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  applyWeightDecay() {
    const decay = this.getWeightDecay();
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    const thresholdWeight = this.getThresholdWeight();

    for (const [bucketKey, bucket] of this.bucketsByTargetSecond) {
      if (bucket.totalWeight <= 0) {
        this.bucketsByTargetSecond.delete(bucketKey);
        continue;
      }

      const nextWeight = Math.max(0, bucket.totalWeight - decay.amount);
      if (nextWeight === bucket.totalWeight) {
        continue;
      }

      bucket.totalWeight = nextWeight;
      this.eventBus.emit(EVENT_NAMES.RULE_WEIGHT_UPDATED, {
        ruleId: BURST_RULE_ID,
        ruleName: 'Extension Weight Burst',
        monitorTargetId: bucket.lastEvent?.monitorTargetId,
        monitorRootPath: bucket.lastEvent?.monitorRootPath,
        path: bucket.lastEvent?.path,
        eventType: 'decay',
        eventWeight: -decay.amount,
        currentWeight: bucket.totalWeight,
        thresholdWeight,
        eventCount: bucket.events.length,
        bucketSecond: bucket.bucketSecond,
        bucketMs: BUCKET_MS,
        decay,
        observedAt,
        observedTs: now
      });

      if (bucket.totalWeight <= 0) {
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
    extensions: [],
    lastEvent: null,
    lastEventWeight: 0
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
