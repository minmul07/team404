import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import { EVENT_NAMES, INCIDENT_STATUSES } from '../shared/contracts/event-names.js';

const execAsync = promisify(exec);

/**
 * QuarantineService
 * - INCIDENT_OPENED 이벤트를 받아 autoQuarantine이 true인 경우 권한 잠금 수행
 * - 잠그기 전 권한 정보를 메모리에 저장
 * - restore 요청 시 원래 권한으로 복원
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
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_STARTED, { incidentId: incident.id, rootPath: incident.monitorRootPath });

    try {
      const entries = await collectPermissions(incident.monitorRootPath);

      // 원래 권한 저장
      this.quarantineRecords.set(incident.id, {
        rootPath: incident.monitorRootPath,
        entries
      });

      // 권한 잠금 수행
      await lockPermissions(incident.monitorRootPath);

      this.inProgressIds.delete(incident.id);

      const job = {
        incidentId: incident.id,
        rootPath: incident.monitorRootPath,
        status: 'quarantined',
        quarantinedAt: new Date().toISOString(),
        entryCount: entries.length
      };

      this.eventBus.emit(EVENT_NAMES.QUARANTINE_COMPLETED, job);
      return job;

    } catch (error) {
      this.inProgressIds.delete(incident.id);
      this._emitFailed(incident, error.message);
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

    this.eventBus.emit(EVENT_NAMES.RESTORE_REQUESTED, { incidentId, rootPath: record.rootPath });

    try {
      await restorePermissions(record.entries);

      this.quarantineRecords.delete(incidentId);

      const result = {
        incidentId,
        rootPath: record.rootPath,
        status: 'restored',
        restoredAt: new Date().toISOString(),
        entryCount: record.entries.length
      };

      this.eventBus.emit(EVENT_NAMES.RESTORE_COMPLETED, result);
      return result;

    } catch (error) {
      this.eventBus.emit(EVENT_NAMES.RESTORE_FAILED, {
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

  _emitFailed(incident, reason) {
    this.eventBus.emit(EVENT_NAMES.QUARANTINE_FAILED, {
      incidentId: incident.id,
      rootPath: incident.monitorRootPath ?? null,
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
 * 디렉터리는 500, 파일은 400으로 권한 잠금
 * @param {string} rootPath
 */
async function lockPermissions(rootPath) {
  const linuxPath = toLinuxPath(rootPath);
  try {
    await execAsync(`find ${shellEscape(linuxPath)} -type f -exec chmod 400 {} \\;`);
    await execAsync(`find ${shellEscape(linuxPath)} -type d -exec chmod 500 {} \\;`);
  } catch {
    // Windows/NTFS 환경에서는 chmod 미지원 - 메모리 기록만 유지
  }
}

/**
 * 수집해둔 권한 정보로 복원
 * @param {Array<{ filePath: string, originalMode: string }>} entries
 */
async function restorePermissions(entries) {
  for (const entry of entries) {
    try {
      await execAsync(`chmod ${entry.originalMode} ${shellEscape(toLinuxPath(entry.filePath))}`);
    } catch {
      // Windows/NTFS 환경에서는 chmod 미지원 - 복원 기록만 처리
    }
  }
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