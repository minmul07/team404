import crypto from 'node:crypto';

import { EVENT_NAMES, INCIDENT_STATUSES } from '../shared/contracts/event-names.js';

const ACTIVE_STATUSES = new Set([
  INCIDENT_STATUSES.DETECTED,
  INCIDENT_STATUSES.TRIAGE,
  INCIDENT_STATUSES.QUARANTINE_REQUESTED,
  INCIDENT_STATUSES.QUARANTINING,
  INCIDENT_STATUSES.QUARANTINED,
  INCIDENT_STATUSES.RESTORE_PENDING
]);

const SEVERITY_PRIORITY = new Map([
  ['low', 1],
  ['medium', 2],
  ['high', 3],
  ['critical', 4]
]);

export class IncidentStore {
  constructor({ eventBus }) {
    this.eventBus = eventBus;
    this.incidents = [];
    this.alerts = [];
    this.quarantineJobs = [];
    this.activeIncidentIdsByTarget = new Map();

    this.handleRuleMatch = this.handleRuleMatch.bind(this);
    this.handleRestoreCompleted = this.handleRestoreCompleted.bind(this);
    this.eventBus.on(EVENT_NAMES.RULE_MATCH, this.handleRuleMatch);
    this.eventBus.on(EVENT_NAMES.RESTORE_COMPLETED, this.handleRestoreCompleted);

    this.handleIncidentStatusUpdate = this.handleIncidentStatusUpdate.bind(this);
    this.eventBus.on(EVENT_NAMES.INCIDENT_UPDATED, this.handleIncidentStatusUpdate);

    this.handleQuarantineStarted = this.handleQuarantineStarted.bind(this);
    this.handleQuarantineCompleted = this.handleQuarantineCompleted.bind(this);
    this.handleQuarantineFailed = this.handleQuarantineFailed.bind(this);
    this.eventBus.on(EVENT_NAMES.QUARANTINE_STARTED, this.handleQuarantineStarted);
    this.eventBus.on(EVENT_NAMES.QUARANTINE_COMPLETED, this.handleQuarantineCompleted);
    this.eventBus.on(EVENT_NAMES.QUARANTINE_FAILED, this.handleQuarantineFailed);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.RULE_MATCH, this.handleRuleMatch);
    this.eventBus.off(EVENT_NAMES.RESTORE_COMPLETED, this.handleRestoreCompleted);
    this.eventBus.off(EVENT_NAMES.INCIDENT_UPDATED, this.handleIncidentStatusUpdate);
    this.eventBus.off(EVENT_NAMES.QUARANTINE_STARTED, this.handleQuarantineStarted);
    this.eventBus.off(EVENT_NAMES.QUARANTINE_COMPLETED, this.handleQuarantineCompleted);
    this.eventBus.off(EVENT_NAMES.QUARANTINE_FAILED, this.handleQuarantineFailed);
  }

  handleRestoreCompleted({ incidentId }) {
    const incident = this.incidents.find(i => i.id === incidentId);
    if (incident) {
      incident.status = INCIDENT_STATUSES.RESTORED;
      incident.updatedAt = new Date().toISOString();
    }
    const job = this.quarantineJobs.find(j => j.incidentId === incidentId);
    if (job) {
      job.status = INCIDENT_STATUSES.RESTORED;
    }
  }

  getIncidents() {
    return [...this.incidents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAlerts() {
    return [...this.alerts].sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  }

  getQuarantineJobs() {
    return [...this.quarantineJobs];
  }

  getSummary() {
    const activeCount = this.incidents.filter((incident) => ACTIVE_STATUSES.has(incident.status)).length;

    return {
      totalIncidents: this.incidents.length,
      activeIncidents: activeCount,
      totalAlerts: this.alerts.length
    };
  }

  clear() {
    this.incidents = [];
    this.alerts = [];
    this.quarantineJobs = [];
    this.activeIncidentIdsByTarget.clear();
  }

  handleRuleMatch(match) {
    this.alerts.unshift(match);
    this.alerts = this.alerts.slice(0, 100);

    const targetKey = match.monitorTargetId ?? match.monitorRootPath ?? 'unknown';
    const currentIncident = this.getActiveIncident(targetKey);

    if (!currentIncident) {
      const incident = {
        id: crypto.randomUUID(),
        status: INCIDENT_STATUSES.DETECTED,
        monitorTargetId: match.monitorTargetId,
        monitorRootPath: match.monitorRootPath,
        severity: match.severity ?? 'high',
        autoQuarantine: Boolean(match.autoQuarantine),
        reason: match.reason ?? null,
        openedAt: match.observedAt,
        updatedAt: match.observedAt,
        lastMatchAt: match.observedAt,
        ruleMatches: 1,
        totalObservedEvents: match.eventCount,
        samplePaths: match.samplePaths,
        eventTypes: match.eventTypes ?? [match.eventType].filter(Boolean),
        matchedRuleIds: [match.ruleId],
        matchedRuleNames: [match.ruleName].filter(Boolean)
      };

      this.incidents.unshift(incident);
      this.activeIncidentIdsByTarget.set(targetKey, incident.id);
      this.eventBus.emit(EVENT_NAMES.INCIDENT_OPENED, incident);
      return;
    }

    currentIncident.updatedAt = match.observedAt;
    currentIncident.lastMatchAt = match.observedAt;
    currentIncident.ruleMatches += 1;
    currentIncident.severity = pickHigherSeverity(currentIncident.severity, match.severity);
    currentIncident.autoQuarantine = currentIncident.autoQuarantine || Boolean(match.autoQuarantine);
    currentIncident.reason = match.reason ?? currentIncident.reason;
    currentIncident.totalObservedEvents = Math.max(
      currentIncident.totalObservedEvents,
      match.eventCount
    );
    currentIncident.samplePaths = [...new Set([...currentIncident.samplePaths, ...match.samplePaths])].slice(0, 10);
    currentIncident.eventTypes = [
      ...new Set([...currentIncident.eventTypes, ...(match.eventTypes ?? [match.eventType].filter(Boolean))])
    ];
    currentIncident.matchedRuleIds = [...new Set([...currentIncident.matchedRuleIds, match.ruleId])];
    currentIncident.matchedRuleNames = [
      ...new Set([...currentIncident.matchedRuleNames, match.ruleName].filter(Boolean))
    ];
    this.eventBus.emit(EVENT_NAMES.INCIDENT_UPDATED, currentIncident);
  }

  /**
   * QuarantineService 가 emit 하는 INCIDENT_UPDATED(_source='quarantine') 수신
   * incident.status 와 updatedAt 을 갱신한다.
   *
   * 수신 payload 예시:
   * { id: "uuid", status: "quarantining", updatedAt: "2026-...", _source: "quarantine" }
   */
  handleIncidentStatusUpdate(payload) {
    if (payload._source !== 'quarantine') return;
    const incident = this.incidents.find((item) => item.id === payload.id);
    if (!incident) return;
    incident.status = payload.status;
    incident.updatedAt = payload.updatedAt ?? new Date().toISOString();
  }

  handleQuarantineStarted({ incidentId, rootPath, rootPaths, status }) {
    const existing = this.quarantineJobs.find(j => j.incidentId === incidentId);
    if (existing) {
      existing.status = status;
      existing.rootPath = rootPath ?? existing.rootPath;
      existing.rootPaths = rootPaths ?? existing.rootPaths;
    } else {
      this.quarantineJobs.unshift({ incidentId, rootPath, rootPaths, status });
    }
  }

  handleQuarantineCompleted({ incidentId, rootPath, rootPaths, status, quarantinedAt, entryCount, permissionEntryCount }) {
    const existing = this.quarantineJobs.find(j => j.incidentId === incidentId);
    if (existing) {
      existing.status = status;
      existing.rootPath = rootPath ?? existing.rootPath;
      existing.rootPaths = rootPaths ?? existing.rootPaths;
      existing.quarantinedAt = quarantinedAt;
      existing.entryCount = entryCount;
      existing.permissionEntryCount = permissionEntryCount;
    } else {
      this.quarantineJobs.unshift({ incidentId, rootPath, rootPaths, status, quarantinedAt, entryCount, permissionEntryCount });
    }
  }

  handleQuarantineFailed({ incidentId, rootPath, rootPaths, status, reason }) {
    const existing = this.quarantineJobs.find(j => j.incidentId === incidentId);
    if (existing) {
      existing.status = status;
      existing.rootPath = rootPath ?? existing.rootPath;
      existing.rootPaths = rootPaths ?? existing.rootPaths;
      existing.reason = reason;
    } else {
      this.quarantineJobs.unshift({ incidentId, rootPath, rootPaths, status, reason });
    }
  }

  getActiveIncident(targetKey) {
    const incidentId = this.activeIncidentIdsByTarget.get(targetKey);
    if (!incidentId) {
      return null;
    }

    const incident = this.incidents.find((item) => item.id === incidentId);
    if (!incident || !ACTIVE_STATUSES.has(incident.status)) {
      this.activeIncidentIdsByTarget.delete(targetKey);
      return null;
    }

    return incident;
  }
}

function pickHigherSeverity(currentSeverity = 'high', nextSeverity = 'high') {
  const currentPriority = SEVERITY_PRIORITY.get(currentSeverity) ?? 0;
  const nextPriority = SEVERITY_PRIORITY.get(nextSeverity) ?? 0;

  return nextPriority > currentPriority ? nextSeverity : currentSeverity;
}
