import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_DIR = path.resolve(__dirname, '../../tmp/demo-target');
const BACKUP_FILE = path.resolve(__dirname, '../../tmp/demo-backup.json');
const LOG_FILE = path.resolve(__dirname, '../../tmp/demo-log.jsonl');

// JSON 형식으로 파일에 기록 (다른 팀원 연동용)
function writeLog(entry) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry
    });
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// 사람이 읽기 좋은 형식으로 터미널 출력
function formatTime(isoString) {
    return isoString.replace('T', ' ').substring(0, 19);
}

export async function startAttack() {
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    // 새 데모 시작 시 이전 로그 초기화
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);

    const startTime = new Date().toISOString();

    console.log(`[DEMO] ----------------------------------------`);
    console.log(`${formatTime(startTime)} - 데모 시작`);
    console.log(`[DEMO] Target directory: ${TARGET_DIR}`);
    console.log(`[DEMO] ----------------------------------------`);

    writeLog({ event: 'demo_started', targetDir: TARGET_DIR });

    const backup = {};

    for (let i = 1; i <= 15; i++) {
        const filePath = path.join(TARGET_DIR, `file_${i}.txt`);
        const lockedPath = filePath + '.demo.locked';

        try {
            const originalContent = fs.existsSync(filePath)
                ? fs.readFileSync(filePath, 'utf8')
                : `original content ${i}`;

            backup[`file_${i}.txt`] = originalContent;

            const encoded = Buffer.from(originalContent).toString('base64');
            fs.writeFileSync(filePath, encoded);
            fs.renameSync(filePath, lockedPath);

            const now = new Date().toISOString();
            console.log(`${formatTime(now)} - file_${i}.txt 변조됨 (${i}/15)`);

            writeLog({
                event: 'file_encrypted',
                sourcePath: filePath,
                targetPath: lockedPath,
                index: i
            });

            await new Promise(res => setTimeout(res, 100));

        } catch (error) {
            const now = new Date().toISOString();
            console.error(`${formatTime(now)} - 격리로 차단됨 (file_${i}.txt)`);
            console.error(`[DEMO] Quarantine is active. Further modification blocked.`);

            writeLog({
                event: 'demo_blocked_by_quarantine',
                blockedPath: filePath,
                index: i,
                reason: 'quarantine active'
            });

            fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
            return;
        }
    }

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));

    const endTime = new Date().toISOString();
    writeLog({ event: 'demo_completed', totalFiles: 15 });

    console.log(`[DEMO] ----------------------------------------`);
    console.log(`${formatTime(endTime)} - 시뮬레이션 완료`);
}

export function restoreDemo() {
    if (!fs.existsSync(TARGET_DIR)) {
        console.log('[RESTORE] Target directory not found. Nothing to restore.');
        return;
    }

    // 로깅 기반 복구: 로그 파일에서 변조된 파일 목록 파악
    let logBasedFiles = [];
    if (fs.existsSync(LOG_FILE)) {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        logBasedFiles = lines
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(entry => entry && entry.event === 'file_encrypted')
            .map(entry => path.basename(entry.sourcePath));
    }

    // 파일 시스템 기반 복구: 폴더에서 .demo.locked 파일 직접 탐색
    const lockedFiles = fs.readdirSync(TARGET_DIR)
        .filter(file => file.endsWith('.demo.locked'));

    if (lockedFiles.length === 0) {
        console.log('[RESTORE] No locked files found. Nothing to restore.');
        return;
    }

    // 백업 파일에서 원본 내용 읽어오기
    const backup = fs.existsSync(BACKUP_FILE)
        ? JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'))
        : {};

    const startTime = new Date().toISOString();
    console.log(`[RESTORE] ----------------------------------------`);
    console.log(`${formatTime(startTime)} - 복구 시작`);

    if (logBasedFiles.length > 0) {
        console.log(`[RESTORE] 로그 기반: ${logBasedFiles.length}개 파일 변조 이력 확인`);
    } else {
        console.log(`[RESTORE] 파일 시스템 기반: ${lockedFiles.length}개 잠긴 파일 탐지`);
    }

    console.log(`[RESTORE] ----------------------------------------`);

    writeLog({ event: 'restore_started', targetDir: TARGET_DIR });

    lockedFiles.forEach(file => {
        const lockedPath = path.join(TARGET_DIR, file);
        const originalName = file.replace('.demo.locked', '');
        const originalPath = path.join(TARGET_DIR, originalName);

        const originalContent = backup[originalName] || 'original content';
        fs.writeFileSync(lockedPath, originalContent);
        fs.renameSync(lockedPath, originalPath);

        const now = new Date().toISOString();
        console.log(`${formatTime(now)} - ${file} 복구됨`);

        writeLog({
            event: 'file_restored',
            sourcePath: lockedPath,
            targetPath: originalPath
        });
    });

    if (fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE);

    const endTime = new Date().toISOString();
    writeLog({ event: 'restore_completed', targetDir: TARGET_DIR });

    console.log(`[RESTORE] ----------------------------------------`);
    console.log(`${formatTime(endTime)} - 복구 완료`);
}

// CLI 실행 진입점
const action = process.argv[2];
if (action === 'run') {
    startAttack();
} else if (action === 'restore') {
    restoreDemo();
} else {
    console.log('Usage:');
    console.log('  node src/simulator/demo.js run      # Start attack simulation');
    console.log('  node src/simulator/demo.js restore  # Restore all files');
}