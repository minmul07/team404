import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

export async function startAttack(onEvent = null) {
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    // 새 데모 시작 시 이전 로그 초기화
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);

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
            onEvent?.('modify', filePath);
            fs.renameSync(filePath, lockedPath);
            onEvent?.('create', lockedPath);

            writeLog({
                event: 'file_encrypted',
                sourcePath: filePath,
                targetPath: lockedPath,
                index: i
            });

            await new Promise(res => setTimeout(res, 100));

        } catch {
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
    writeLog({ event: 'demo_completed', totalFiles: 15 });
}

export function restoreDemo() {
    if (!fs.existsSync(TARGET_DIR)) {
        return;
    }

    // 파일 시스템 기반 복구: 폴더에서 .demo.locked 파일 직접 탐색
    const lockedFiles = fs.readdirSync(TARGET_DIR)
        .filter(file => file.endsWith('.demo.locked'));

    if (lockedFiles.length === 0) {
        return;
    }

    // 백업 파일에서 원본 내용 읽어오기
    const backup = fs.existsSync(BACKUP_FILE)
        ? JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'))
        : {};

    writeLog({ event: 'restore_started', targetDir: TARGET_DIR });

    lockedFiles.forEach(file => {
        const lockedPath = path.join(TARGET_DIR, file);
        const originalName = file.replace('.demo.locked', '');
        const originalPath = path.join(TARGET_DIR, originalName);

        const originalContent = backup[originalName] || 'original content';
        fs.writeFileSync(lockedPath, originalContent);
        fs.renameSync(lockedPath, originalPath);

        writeLog({
            event: 'file_restored',
            sourcePath: lockedPath,
            targetPath: originalPath
        });
    });

    if (fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE);
    writeLog({ event: 'restore_completed', targetDir: TARGET_DIR });
}

if (isDirectCliExecution()) {
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
}

function isDirectCliExecution() {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
