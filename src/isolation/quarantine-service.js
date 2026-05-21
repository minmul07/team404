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

// killProcessesSafe 가 SIGTERM/SIGKILL 을 보낼 수 있는 경로 세그먼트 (데모용 범위만 허용)
const SAFE_KILL_PATH_SEGMENT = 'demo-target';

/**
 * QuarantineService
 * - INCIDENT_OPENED 이벤트를 받아 autoQuarantine이 true인 경우 권한 잠금 수행
 * - 잠그기 전 권한 정보를 메모리에 저장
 * - restore 요청 시 원래 권한으로 복원
 * - 상태 흐름: DETECTED → QUARANTINING → QUARANTINED → RESTORED / FAILED
 */
export class QuarantineService {
  constructor({ eventBus, getResponsePolicy, getWatchTargets, processKiller = process.kill }) {
    this.eventBus = eventBus;
    this.getResponsePolicy = getResponsePolicy ?? (() => ({
      lockDirectoryPermissions: true,
      killSuspectProcesses: false,
      shutdownSystem: false,
      quarantineScope: 'incident-target'
    }));
    this.getWatchTargets = getWatchTargets ?? (() => []);
    this.processKiller = processKiller;

    // incidentId -> { rootPath, rootPaths, records: [{ rootPath, entries }] }
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

    const responsePolicy = this.getResponsePolicy();
    const rootPaths = resolveQuarantineRootPaths({
      incident,
      responsePolicy,
      watchTargets: this.getWatchTargets()
    });
    const primaryRootPath = rootPaths[0];

    if (rootPaths.length === 0) {
      this._emitFailed(incident, '격리할 감시 디렉터리를 찾을 수 없습니다.');
      return;
    }

    this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.QUARANTINING);
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_STARTED, {
      incidentId: incident.id,
      rootPath: primaryRootPath,
      rootPaths,
      status: INCIDENT_STATUSES.QUARANTINING
    });
    await appendLog({
      eventType: 'quarantine_started',
      incidentId: incident.id,
      rootPath: primaryRootPath,
      rootPaths
    });

    try {
      const records = [];

      for (const rootPath of rootPaths) {
        const entries = responsePolicy.lockDirectoryPermissions
          ? await collectPermissions(rootPath)
          : [];
        records.push({ rootPath, entries });
      }

      // 원래 권한 저장
      this.quarantineRecords.set(incident.id, {
        rootPath: primaryRootPath,
        rootPaths,
        records
      });

      // 해당 경로를 점유 중인 프로세스 종료 (demo-target 범위만)
      if (responsePolicy.killSuspectProcesses) {
        for (const rootPath of rootPaths) {
          const killedPids = await killProcessesSafe(rootPath, {
            suspectProcesses: incident.suspectProcesses,
            killProcess: this.processKiller
          });
          await appendLog({
            eventType: 'quarantine_progress',
            incidentId: incident.id,
            rootPath,
            detail: `processes_killed`,
            pids: killedPids
          });
        }
      }

      // quarantine.sh 호출 – per-file progress stdout 파싱
      if (responsePolicy.lockDirectoryPermissions) {
        for (const rootPath of rootPaths) {
          const progressItems = await lockPermissions(rootPath);
          for (const item of progressItems) {
            await appendLog({
              eventType: 'quarantine_progress',
              incidentId: incident.id,
              rootPath,
              filePath: item.filePath,
              result: item.result
            });
          }
        }
      }

      if (responsePolicy.shutdownSystem) {
        const shutdownResult = await requestSystemShutdown();
        await appendLog({
          eventType: 'quarantine_progress',
          incidentId: incident.id,
          rootPath: primaryRootPath,
          rootPaths,
          detail: 'system_shutdown',
          result: shutdownResult.status,
          reason: shutdownResult.reason
        });
      }

      this.inProgressIds.delete(incident.id);
      const summary = summarizeRecords(records);

      const job = {
        incidentId: incident.id,
        rootPath: primaryRootPath,
        rootPaths,
        status: INCIDENT_STATUSES.QUARANTINED,
        quarantinedAt: new Date().toISOString(),
        entryCount: summary.entryCount,
        permissionEntryCount: summary.permissionEntryCount
      };

      // 상태: QUARANTINED
      this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.QUARANTINED);
      this.eventBus.emit(EVENT_NAMES.QUARANTINE_COMPLETED, job);
      await appendLog({
        eventType: 'quarantine_completed',
        incidentId: incident.id,
        rootPath: primaryRootPath,
        rootPaths,
        entryCount: summary.entryCount,
        permissionEntryCount: summary.permissionEntryCount
      });

      return job;

    } catch (error) {
      this.inProgressIds.delete(incident.id);
      this._emitFailed(incident, error.message, rootPaths);
      await appendLog({
        eventType: 'quarantine_failed',
        incidentId: incident.id,
        rootPath: primaryRootPath ?? incident.monitorRootPath ?? null,
        rootPaths,
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

    const records = normalizeRecordEntries(record);
    const rootPaths = records.map((item) => item.rootPath);
    const primaryRootPath = rootPaths[0] ?? record.rootPath;

    this.eventBus.emit(EVENT_NAMES.RESTORE_REQUESTED, {
      incidentId,
      rootPath: primaryRootPath,
      rootPaths
    });
    await appendLog({
      eventType: 'restore_requested',
      incidentId,
      rootPath: primaryRootPath,
      rootPaths
    });

    try {
      // restore.sh 를 entry 단위로 호출 – per-file 결과 로깅
      for (const rootRecord of records) {
        const progressItems = await restorePermissions(rootRecord.entries);
        for (const item of progressItems) {
          await appendLog({
            eventType: 'quarantine_progress',
            incidentId,
            rootPath: rootRecord.rootPath,
            filePath: item.filePath,
            result: item.result
          });
        }
      }

      const summary = summarizeRecords(records);

      this.quarantineRecords.delete(incidentId);

      const result = {
        incidentId,
        rootPath: primaryRootPath,
        rootPaths,
        status: INCIDENT_STATUSES.RESTORED,
        restoredAt: new Date().toISOString(),
        entryCount: summary.entryCount,
        permissionEntryCount: summary.permissionEntryCount,
        decryptedFileCount: 0
      };

      // 상태: RESTORED
      this._emitIncidentUpdated(incidentId, INCIDENT_STATUSES.RESTORED);
      this.eventBus.emit(EVENT_NAMES.RESTORE_COMPLETED, result);
      await appendLog({
        eventType: 'restore_completed',
        incidentId,
        rootPath: primaryRootPath,
        rootPaths,
        entryCount: summary.entryCount,
        permissionEntryCount: summary.permissionEntryCount
      });

      return result;

    } catch (error) {
      this.eventBus.emit(EVENT_NAMES.RESTORE_FAILED, {
        incidentId,
        rootPath: primaryRootPath,
        rootPaths,
        reason: error.message
      });
      await appendLog({
        eventType: 'restore_failed',
        incidentId,
        rootPath: primaryRootPath,
        rootPaths,
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
      const records = normalizeRecordEntries(record);
      const rootPaths = records.map((item) => item.rootPath);
      const summary = summarizeRecords(records);
      jobs.push({
        incidentId,
        rootPath: rootPaths[0] ?? record.rootPath,
        rootPaths,
        entryCount: summary.entryCount,
        permissionEntryCount: summary.permissionEntryCount
      });
    }
    return jobs;
  }

  clearRecords() {
    this.quarantineRecords.clear();
    this.inProgressIds.clear();
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

  _emitFailed(incident, reason, rootPaths = null) {
    const failedRootPaths = rootPaths ?? (incident.monitorRootPath ? [incident.monitorRootPath] : []);
    this._emitIncidentUpdated(incident.id, INCIDENT_STATUSES.FAILED);
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_FAILED, {
      incidentId: incident.id,
      rootPath: failedRootPaths[0] ?? incident.monitorRootPath ?? null,
      rootPaths: failedRootPaths,
      status: INCIDENT_STATUSES.FAILED,
      reason
    });
  }
}

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
    entries.push({
      filePath: currentPath,
      originalMode: mode,
      entryType: stat.isDirectory() ? 'dir' : 'file'
    });

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

function countFileEntries(entries) {
  return entries.filter((entry) => entry.entryType === 'file').length;
}

function resolveQuarantineRootPaths({ incident, responsePolicy, watchTargets }) {
  if (responsePolicy.quarantineScope !== 'all-watch-targets') {
    return [incident.monitorRootPath].filter(Boolean);
  }

  return uniqueRootPaths([
    incident.monitorRootPath,
    ...watchTargets.map((target) => target?.rootPath)
  ]);
}

function uniqueRootPaths(rootPaths) {
  const seen = new Set();
  const unique = [];

  for (const rootPath of rootPaths) {
    if (!rootPath) {
      continue;
    }

    const resolvedPath = path.resolve(rootPath);
    if (seen.has(resolvedPath)) {
      continue;
    }

    seen.add(resolvedPath);
    unique.push(resolvedPath);
  }

  return unique;
}

function normalizeRecordEntries(record) {
  if (Array.isArray(record.records)) {
    return record.records;
  }

  return [
    {
      rootPath: record.rootPath,
      entries: record.entries ?? []
    }
  ];
}

function summarizeRecords(records) {
  return records.reduce((summary, record) => {
    const entries = record.entries ?? [];
    summary.entryCount += countFileEntries(entries);
    summary.permissionEntryCount += entries.length;
    return summary;
  }, {
    entryCount: 0,
    permissionEntryCount: 0
  });
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
      await execAsync(`find ${shellEscape(linuxPath)} -type f -exec chmod 000 {} \\;`);
      await execAsync(`find ${shellEscape(linuxPath)} -type d -exec chmod 000 {} \\;`);
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
 * 안전성을 위해 demo-target 경로만 허용하고, PID가 실제 rootPath 하위 경로를
 * 점유하는지 /proc 로 재검증한다.
 *
 * 전략: lsof 로 PID 수집, SIGTERM 우선, 실패 시 SIGKILL
 *
 * @param {string} rootPath
 * @returns {Promise<number[]>} 종료 시도한 PID 목록
 */
async function killProcessesSafe(rootPath, { suspectProcesses = [], killProcess = process.kill } = {}) {
  const resolvedRootPath = path.resolve(rootPath);
  if (!isSafeKillRoot(resolvedRootPath)) {
    return [];
  }

  const excludedPids = new Set([1, process.pid, process.ppid].filter(Boolean));
  const safePids = [];
  const seenPids = new Set();

  for (const pid of collectSuspectPids(suspectProcesses, resolvedRootPath)) {
    if (!excludedPids.has(pid) && !seenPids.has(pid)) {
      seenPids.add(pid);
      safePids.push(pid);
    }
  }

  const pids = await collectPids(resolvedRootPath);
  for (const pid of pids) {
    if (excludedPids.has(pid) || seenPids.has(pid)) {
      continue;
    }

    seenPids.add(pid);
    if (await processUsesPathUnderRoot(pid, resolvedRootPath)) {
      safePids.push(pid);
    }
  }

  const killed = [];
  for (const pid of safePids) {
    try {
      killProcess(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      try {
        killProcess(pid, 'SIGKILL');
        killed.push(pid);
      } catch {
        // 이미 종료됐거나 권한 없음 – 무시
      }
    }
  }
  return killed;
}

function collectSuspectPids(suspectProcesses, rootPath) {
  if (!Array.isArray(suspectProcesses)) {
    return [];
  }

  return suspectProcesses
    .filter((processInfo) => isPathInside(processInfo?.path ?? rootPath, rootPath))
    .map((processInfo) => Number(processInfo?.pid))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/**
 * rootPath 를 사용 중인 PID 목록 수집 (lsof 만 사용)
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

  // 마운트 단위 PID 조회는 같은 파일시스템의 프로세스를 넓게 반환할 수 있어 사용하지 않는다.
  return [];
}

async function requestSystemShutdown() {
  if (process.env.TEAM404_ALLOW_SYSTEM_SHUTDOWN !== '1') {
    return {
      status: 'skipped',
      reason: 'TEAM404_ALLOW_SYSTEM_SHUTDOWN is not enabled'
    };
  }

  const commands = [
    'systemctl poweroff --force --force',
    'poweroff -f'
  ];

  const failures = [];
  for (const command of commands) {
    try {
      await execAsync(command);
      return { status: 'requested', command };
    } catch (error) {
      failures.push(`${command}: ${error.message}`);
    }
  }

  return {
    status: 'failed',
    reason: failures.join(' | ')
  };
}

function isSafeKillRoot(rootPath) {
  return path.resolve(rootPath).split(path.sep).includes(SAFE_KILL_PATH_SEGMENT);
}

async function processUsesPathUnderRoot(pid, rootPath) {
  const procPaths = await readProcessPaths(pid);
  return procPaths.some((procPath) => isPathInside(procPath, rootPath));
}

async function readProcessPaths(pid) {
  const procPaths = [];
  const cwdPath = await readProcLink(`/proc/${pid}/cwd`);
  if (cwdPath) {
    procPaths.push(cwdPath);
  }

  let fdNames = [];
  try {
    fdNames = await fs.readdir(`/proc/${pid}/fd`);
  } catch {
    return procPaths;
  }

  for (const fdName of fdNames) {
    const fdPath = await readProcLink(`/proc/${pid}/fd/${fdName}`);
    if (fdPath) {
      procPaths.push(fdPath);
    }
  }

  return procPaths;
}

async function readProcLink(linkPath) {
  try {
    const linkTarget = await fs.readlink(linkPath);
    return normalizeProcPath(linkTarget);
  } catch {
    return null;
  }
}

function normalizeProcPath(procPath) {
  if (typeof procPath !== 'string') {
    return null;
  }

  const deletedSuffix = ' (deleted)';
  const normalizedPath = procPath.endsWith(deletedSuffix)
    ? procPath.slice(0, -deletedSuffix.length)
    : procPath;

  if (!path.isAbsolute(normalizedPath)) {
    return null;
  }

  return path.resolve(normalizedPath);
}

function isPathInside(candidatePath, rootPath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === ''
    || (relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
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
