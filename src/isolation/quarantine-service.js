import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_NAMES, INCIDENT_STATUSES } from '../shared/contracts/event-names.js';
import { appendLog } from './quarantine-logger.js';

const execAsync = promisify(exec);

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ops/scripts');
const QUARANTINE_SCRIPT = path.join(SCRIPTS_DIR, 'quarantine.sh');
const RESTORE_SCRIPT = path.join(SCRIPTS_DIR, 'restore.sh');

// killProcessesSafe 가 SIGTERM/SIGKILL 을 보낼 수 있는 경로 패턴 (데모용 범위만 허용)
const SAFE_KILL_PATH_PATTERN = /demo-target|demo/i;

/**
 * QuarantineService
 * - INCIDENT_OPENED 이벤트를 받아 autoQuarantine이 true인 경우 권한 잠금 수행
 * - 잠그기 전 권한 정보를 메모리에 저장
 * - restore 요청 시 원래 권한으로 복원
 * - 상태 흐름: DETECTED → QUARANTINING → QUARANTINED → RESTORED / FAILED
 */
export class QuarantineService {
  constructor({ eventBus }) {
    this.eventBus = eventBus;

    // incidentId -> { rootPath, entries: [{ filePath, originalMode }] }
    this.quarantineRecords = new Map();

    // 중복 격리 방지: 현재 처리 중인 incidentId 추적
    this.inProgressIds = new Set();

    this.handleIncidentOpened = this.handleIncidentOpened.bind(this);
    this.eventBus.on(EVENT_NAMES.INCIDENT_OPENED, this.handleIncidentOpened);
  }

  stop() {
    this.eventBus.off(EVENT_NAMES.INCIDENT_OPENED, this.handleIncidentOpened);
  }

  /**
   * INCIDENT_OPENED 이벤트 핸들러
   * autoQuarantine이 true인 경우에만 격리 수행
   */
  async handleIncidentOpened(incident) {
    if (!incident.autoQuarantine) {
      return;
    }

    if (!incident.monitorRootPath) {
      this._emitFailed(incident, 'monitorRootPath가 없어 격리할 경로를 알 수 없습니다.');
      return;
    }

    // 중복 격리 방지
    if (this.inProgressIds.has(incident.id) || this.quarantineRecords.has(incident.id)) {
      return;
    }

    this.inProgressIds.add(incident.id);

    // 상태: QUARANTINING
    this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.QUARANTINING);
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_STARTED, {
      incidentId: incident.id,
      rootPath: incident.monitorRootPath
    });
    await appendLog({
      eventType: 'quarantine_started',
      incidentId: incident.id,
      rootPath: incident.monitorRootPath
    });

    try {
      const entries = await collectPermissions(incident.monitorRootPath);

      // 원래 권한 저장
      this.quarantineRecords.set(incident.id, {
        rootPath: incident.monitorRootPath,
        entries
      });

      // 해당 경로를 점유 중인 프로세스 종료 (demo-target 범위만)
      const killedPids = await killProcessesSafe(incident.monitorRootPath);
      if (killedPids.length > 0) {
        await appendLog({
          eventType: 'quarantine_progress',
          incidentId: incident.id,
          rootPath: incident.monitorRootPath,
          detail: `processes_killed`,
          pids: killedPids
        });
      }

      // quarantine.sh 호출 – per-file progress stdout 파싱
      const progressItems = await lockPermissions(incident.monitorRootPath);
      for (const item of progressItems) {
        await appendLog({
          eventType: 'quarantine_progress',
          incidentId: incident.id,
          rootPath: incident.monitorRootPath,
          filePath: item.filePath,
          result: item.result
        });
      }

      this.inProgressIds.delete(incident.id);

      const job = {
        incidentId: incident.id,
        rootPath: incident.monitorRootPath,
        status: 'quarantined',
        quarantinedAt: new Date().toISOString(),
        entryCount: entries.length
      };

      // 상태: QUARANTINED
      this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.QUARANTINED);
      this.eventBus.emit(EVENT_NAMES.QUARANTINE_COMPLETED, job);
      await appendLog({
        eventType: 'quarantine_completed',
        incidentId: incident.id,
        rootPath: incident.monitorRootPath,
        entryCount: entries.length
      });

      return job;

    } catch (error) {
      this.inProgressIds.delete(incident.id);
      this._emitFailed(incident, error.message);
      await appendLog({
        eventType: 'quarantine_failed',
        incidentId: incident.id,
        rootPath: incident.monitorRootPath ?? null,
        reason: error.message
      });
    }
  }

  /**
   * 복원 요청 처리
   * @param {string} incidentId
   */
  async restore(incidentId) {
    const record = this.quarantineRecords.get(incidentId);

    if (!record) {
      const error = new Error(`incidentId ${incidentId}에 대한 격리 기록이 없습니다.`);
      error.statusCode = 404;
      throw error;
    }

    this.eventBus.emit(EVENT_NAMES.RESTORE_REQUESTED, {
      incidentId,
      rootPath: record.rootPath
    });
    await appendLog({
      eventType: 'restore_requested',
      incidentId,
      rootPath: record.rootPath
    });

    try {
      // restore.sh 를 entry 단위로 호출 – per-file 결과 로깅
      const progressItems = await restorePermissions(record.entries);
      for (const item of progressItems) {
        await appendLog({
          eventType: 'quarantine_progress',
          incidentId,
          rootPath: record.rootPath,
          filePath: item.filePath,
          result: item.result
        });
      }

      this.quarantineRecords.delete(incidentId);

      const result = {
        incidentId,
        rootPath: record.rootPath,
        status: 'restored',
        restoredAt: new Date().toISOString(),
        entryCount: record.entries.length
      };

      // 상태: RESTORED
      this._emitIncidentUpdated(incidentId, INCIDENT_STATUSES.RESTORED);
      this.eventBus.emit(EVENT_NAMES.RESTORE_COMPLETED, result);
      await appendLog({
        eventType: 'restore_completed',
        incidentId,
        rootPath: record.rootPath,
        entryCount: record.entries.length
      });

      return result;

    } catch (error) {
      this.eventBus.emit(EVENT_NAMES.RESTORE_FAILED, {
        incidentId,
        rootPath: record.rootPath,
        reason: error.message
      });
      await appendLog({
        eventType: 'restore_failed',
        incidentId,
        rootPath: record.rootPath,
        reason: error.message
      });
      throw error;
    }
  }

  /**
   * 현재 격리 중인 작업 목록 반환
   */
  getQuarantineJobs() {
    const jobs = [];
    for (const [incidentId, record] of this.quarantineRecords.entries()) {
      jobs.push({
        incidentId,
        rootPath: record.rootPath,
        entryCount: record.entries.length
      });
    }
    return jobs;
  }

  /**
   * INCIDENT_UPDATED 이벤트 emit (quarantine 출처 표시)
   * IncidentStore 가 이 이벤트를 수신해 incident.status 를 갱신할 수 있다.
   *
   * payload 예시:
   * {
   *   id: "uuid-...",
   *   status: "quarantining",   // INCIDENT_STATUSES 값
   *   updatedAt: "2026-05-10T...",
   *   _source: "quarantine"     // IncidentStore 루프 방지용 식별자
   * }
   *
   * @param {string} incidentId
   * @param {string} status  INCIDENT_STATUSES 중 하나
   */
  _emitIncidentUpdated(incidentId, status) {
    this.eventBus.emit(EVENT_NAMES.INCIDENT_UPDATED, {
      id: incidentId,
      status,
      updatedAt: new Date().toISOString(),
      _source: 'quarantine'
    });
  }

  _emitFailed(incident, reason) {
    this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.FAILED);
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_FAILED, {
      incidentId: incident.id,
      rootPath: incident.monitorRootPath ?? null,
      reason
    });
  }
}

// ---------------------------------------------------------------------------
// 내부 헬퍼 함수
// ---------------------------------------------------------------------------

/**
 * 디렉터리 하위의 모든 파일/폴더 권한을 수집
 * @param {string} rootPath
 * @returns {Promise<Array<{ filePath: string, originalMode: string }>>}
 */
async function collectPermissions(rootPath) {
  const entries = [];

  async function walk(currentPath) {
    const stat = await fs.stat(currentPath);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    entries.push({ filePath: currentPath, originalMode: mode });

    if (stat.isDirectory()) {
      const children = await fs.readdir(currentPath);
      for (const child of children) {
        await walk(path.join(currentPath, child));
      }
    }
  }

  await walk(rootPath);
  return entries;
}

/**
 * quarantine.sh 를 호출해 파일/폴더 권한을 잠근다.
 * stdout 에서 per-file 진행 결과를 파싱해 반환한다.
 *
 * @param {string} rootPath
 * @returns {Promise<Array<{ filePath: string, result: 'success'|'failed' }>>}
 */
async function lockPermissions(rootPath) {
  try {
    const { stdout } = await execAsync(
      `bash ${shellEscape(QUARANTINE_SCRIPT)} ${shellEscape(rootPath)}`
    );
    return parseProgressOutput(stdout);
  } catch {
    const linuxPath = toLinuxPath(rootPath);
    try {
      await execAsync(`find ${shellEscape(linuxPath)} -type f -exec chmod 400 {} \\;`);
      await execAsync(`find ${shellEscape(linuxPath)} -type d -exec chmod 500 {} \\;`);
    } catch {
      // Windows/NTFS 환경에서는 chmod 미지원 - 메모리 기록만 유지
    }
    return [];
  }
}
/**
 * restore.sh 를 entry 단위로 호출해 원래 권한을 복원한다.
 * 개별 실패는 기록하되 전체 복원을 중단하지 않는다.
 *
 * @param {Array<{ filePath: string, originalMode: string }>} entries
 * @returns {Promise<Array<{ filePath: string, result: 'success'|'failed', reason?: string }>>}
 */
async function restorePermissions(entries) {
  const results = [];
  for (const entry of entries) {
    try {
      await execAsync(
        `bash ${shellEscape(RESTORE_SCRIPT)} ${shellEscape(entry.filePath)} ${shellEscape(entry.originalMode)}`
      );
      results.push({ filePath: entry.filePath, result: 'success' });
    } catch (error) {
      try {
        await execAsync(`chmod ${entry.originalMode} ${shellEscape(toLinuxPath(entry.filePath))}`);
        results.push({ filePath: entry.filePath, result: 'success' });
      } catch {
        // Windows/NTFS 환경에서는 chmod 미지원 - 복원 기록만 처리
        results.push({ filePath: entry.filePath, result: 'failed', reason: error.message });
      }
    }
  }
  return results;
}

/**
 * quarantine.sh stdout (탭 구분 PROGRESS 라인) 파싱
 * 형식: PROGRESS\t<file|dir>\t<path>\t<success|failed>
 *
 * @param {string} stdout
 * @returns {Array<{ filePath: string, result: 'success'|'failed' }>}
 */
function parseProgressOutput(stdout) {
  const items = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts[0] === 'PROGRESS' && parts.length === 4) {
      items.push({ filePath: parts[2], result: parts[3].trim() });
    }
  }
  return items;
}

/**
 * rootPath 를 점유 중인 프로세스를 종료한다.
 * 안전성을 위해 demo-target 경로만 허용한다.
 *
 * 전략: lsof → fuser 순으로 PID 수집, SIGTERM 우선, 실패 시 SIGKILL
 *
 * @param {string} rootPath
 * @returns {Promise<number[]>} 종료 시도한 PID 목록
 */
async function killProcessesSafe(rootPath) {
  if (!SAFE_KILL_PATH_PATTERN.test(path.resolve(rootPath))) {
    return [];
  }

  const pids = await collectPids(rootPath);
  const ownPid = process.pid;
  const safePids = pids.filter((pid) => pid > 1 && pid !== ownPid);

  const killed = [];
  for (const pid of safePids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch {
        // 이미 종료됐거나 권한 없음 – 무시
      }
    }
  }
  return killed;
}

/**
 * rootPath 를 사용 중인 PID 목록 수집 (lsof → fuser 순 시도)
 * @param {string} rootPath
 * @returns {Promise<number[]>}
 */
async function collectPids(rootPath) {
  // lsof +D: 디렉터리 하위까지 재귀 탐색
  try {
    const { stdout } = await execAsync(
      `lsof -t +D ${shellEscape(rootPath)} 2>/dev/null`
    );
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (pids.length > 0) return pids;
  } catch { /* lsof 없거나 실패 */ }

  // fuser -m: 마운트 포인트 기반 (fallback)
  try {
    const { stdout } = await execAsync(
      `fuser -m ${shellEscape(rootPath)} 2>/dev/null`
    );
    return stdout
      .trim()
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch { /* fuser 없거나 실패 */ }

  return [];
}

function toLinuxPath(p) {
  // C:\Users\... → /mnt/c/Users/...
  return p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

/**
 * shell 명령에서 경로를 안전하게 이스케이프
 * @param {string} value
 */
function shellEscape(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
