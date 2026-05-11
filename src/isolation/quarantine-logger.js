import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'quarantine.log');

/**
 * quarantine 이벤트를 logs/quarantine.log 에 append-only JSONL 형태로 기록
 *
 * 지원 eventType:
 *   quarantine_started | quarantine_progress | quarantine_completed | quarantine_failed
 *   restore_requested  | restore_completed   | restore_failed
 *
 * @param {{ eventType: string, incidentId: string, rootPath?: string, [key: string]: any }} entry
 */
export async function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch {
    // 로깅 실패가 서비스를 중단시켜서는 안 된다
  }
}
