export const EVENT_NAMES = Object.freeze({
  FS_EVENT: 'fs_event',
  RULE_MATCH: 'rule_match',
  INCIDENT_OPENED: 'incident_opened',
  INCIDENT_UPDATED: 'incident_updated',
  QUARANTINE_REQUESTED: 'quarantine_requested',
  QUARANTINE_STARTED: 'quarantine_started',
  QUARANTINE_COMPLETED: 'quarantine_completed',
  QUARANTINE_FAILED: 'quarantine_failed',
  RESTORE_REQUESTED: 'restore_requested',
  RESTORE_COMPLETED: 'restore_completed',
  RESTORE_FAILED: 'restore_failed',
  DEMO_STARTED: 'demo_started',
  DEMO_ABORTED: 'demo_aborted',
  DEMO_COMPLETED: 'demo_completed',
  SYSTEM_HEALTH: 'system_health'
});

export const FILE_EVENT_TYPES = Object.freeze({
  CREATE: 'create',
  MODIFY: 'modify',
  DELETE: 'delete',
  RENAME: 'rename'
});

export const INCIDENT_STATUSES = Object.freeze({
  DETECTED: 'detected',
  TRIAGE: 'triage',
  QUARANTINE_REQUESTED: 'quarantine_requested',
  QUARANTINING: 'quarantining',
  QUARANTINED: 'quarantined',
  RESTORE_PENDING: 'restore_pending',
  RESTORED: 'restored',
  FAILED: 'failed',
  CLOSED: 'closed'
});

export const API_ROUTES = Object.freeze({
  SNAPSHOT: '/api/snapshot',
  INCIDENTS: '/api/incidents',
  HEALTH: '/api/health',
  ALERTS: '/api/alerts',
  QUARANTINE_JOBS: '/api/quarantine-jobs'
});
