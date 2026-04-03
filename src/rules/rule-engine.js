import crypto from 'node:crypto';

import { EVENT_NAMES } from '../shared/contracts/event-names.js';

export class RuleEngine {
  constructor({ eventBus, config }) {
    this.eventBus = eventBus;
    this.rules = config.rules.definitions;
    this.rulesByEventType = groupRulesByEventType(this.rules);
    this.eventsByRuleKey = new Map();
    this.lastMatchByRuleKey = new Map();
    this.lastMatchAt = null;

    this.handleFsEvent = this.handleFsEvent.bind(this);
    this.eventBus.on(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.FS_EVENT, this.handleFsEvent);
  }

  getState() {
    return {
      activeRuleWindows: this.eventsByRuleKey.size,
      configuredRules: this.rules.map((rule) => ({
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        eventType: rule.eventType,
        threshold: rule.threshold,
        windowMs: rule.windowMs,
        incidentCooldownMs: rule.incidentCooldownMs
      })),
      lastMatchAt: this.lastMatchAt
    };
  }

  handleFsEvent(event) {
    const matchingRules = this.rulesByEventType.get(event.type) ?? [];

    for (const rule of matchingRules) {
      const targetKey = event.monitorTargetId ?? event.monitorRootPath ?? 'unknown';
      const ruleKey = `${targetKey}:${rule.ruleId}`;
      const nowTs = event.observedTs;
      const bucket = this.eventsByRuleKey.get(ruleKey) ?? [];
      const windowStart = nowTs - rule.windowMs;
      const recent = bucket.filter((item) => item.observedTs >= windowStart);
      recent.push(event);
      this.eventsByRuleKey.set(ruleKey, recent);

      const lastMatchTs = this.lastMatchByRuleKey.get(ruleKey);
      const cooldownElapsed =
        lastMatchTs === undefined || nowTs - lastMatchTs >= rule.incidentCooldownMs;

      if (recent.length < rule.threshold || !cooldownElapsed) {
        continue;
      }

      const samplePaths = [...new Set(recent.map((item) => item.path))].slice(0, 10);
      const match = {
        id: crypto.randomUUID(),
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        eventType: rule.eventType,
        severity: rule.severity,
        autoQuarantine: rule.autoQuarantine,
        reason: `${rule.eventType} events reached ${recent.length}/${rule.threshold} within ${rule.windowMs}ms`,
        observedAt: event.observedAt,
        observedTs: event.observedTs,
        monitorTargetId: event.monitorTargetId,
        monitorRootPath: event.monitorRootPath,
        windowMs: rule.windowMs,
        threshold: rule.threshold,
        eventCount: recent.length,
        samplePaths,
        targetPaths: samplePaths,
        eventTypes: [rule.eventType]
      };

      this.lastMatchByRuleKey.set(ruleKey, nowTs);
      this.lastMatchAt = event.observedAt;
      this.eventBus.emit(EVENT_NAMES.RULE_MATCH, match);
    }
  }
}

function groupRulesByEventType(rules) {
  const grouped = new Map();

  for (const rule of rules) {
    const bucket = grouped.get(rule.eventType) ?? [];
    bucket.push(rule);
    grouped.set(rule.eventType, bucket);
  }

  return grouped;
}
