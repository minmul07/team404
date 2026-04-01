import crypto from 'node:crypto';

import { EVENT_NAMES } from '../shared/contracts/event-names.js';

export class RuleEngine {
  constructor({ eventBus, config }) {
    this.eventBus = eventBus;
    this.config = config;
    this.eventsByTarget = new Map();
    this.lastMatchByTarget = new Map();
    this.lastMatchAt = null;

    this.handleFsEvent = this.handleFsEvent.bind(this);
    this.eventBus.on(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  getState() {
    return {
      burstWindowMs: this.config.rules.burstWindowMs,
      burstThreshold: this.config.rules.burstThreshold,
      incidentCooldownMs: this.config.rules.incidentCooldownMs,
      activeTargetWindows: this.eventsByTarget.size,
      lastMatchAt: this.lastMatchAt
    };
  }

  handleFsEvent(event) {
    const targetKey = event.monitorTargetId ?? event.monitorRootPath ?? 'unknown';
    const nowTs = event.observedTs;
    const bucket = this.eventsByTarget.get(targetKey) ?? [];
    const windowStart = nowTs - this.config.rules.burstWindowMs;
    const recent = bucket.filter((item) => item.observedTs >= windowStart);
    recent.push(event);
    this.eventsByTarget.set(targetKey, recent);

    const lastMatchTs = this.lastMatchByTarget.get(targetKey) ?? 0;
    const cooldownElapsed = nowTs - lastMatchTs >= this.config.rules.incidentCooldownMs;

    if (recent.length < this.config.rules.burstThreshold || !cooldownElapsed) {
      return;
    }

    const uniquePaths = [...new Set(recent.map((item) => item.path))].slice(0, 5);
    const recentTypes = [...new Set(recent.map((item) => item.type))];
    const match = {
      id: crypto.randomUUID(),
      ruleId: 'burst-threshold',
      observedAt: event.observedAt,
      observedTs: event.observedTs,
      monitorTargetId: event.monitorTargetId,
      monitorRootPath: event.monitorRootPath,
      windowMs: this.config.rules.burstWindowMs,
      threshold: this.config.rules.burstThreshold,
      eventCount: recent.length,
      samplePaths: uniquePaths,
      eventTypes: recentTypes
    };

    this.lastMatchByTarget.set(targetKey, nowTs);
    this.lastMatchAt = event.observedAt;
    this.eventBus.emit(EVENT_NAMES.RULE_MATCH, match);
  }
}
