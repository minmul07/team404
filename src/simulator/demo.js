import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const DEMO_TARGET_DIR = 'tmp/demo-target';

const TARGET_DIR = path.resolve(DEMO_TARGET_DIR);
const BACKUP_FILE = path.resolve('tmp/demo-backup.json');
const LOG_FILE = path.resolve('tmp/demo-log.jsonl');
const DEMO_FILE_COUNT = 15;
const DEMO_DIR_MODE = 0o755;
const DEMO_FILE_MODE = 0o644;

// JSON 형식으로 파일에 기록 (다른 팀원 연동용)
function writeLog(entry) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry
    });
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendDemoLog(line + '\n');
}

function appendDemoLog(line) {
    try {
        fs.appendFileSync(LOG_FILE, line);
        return;
    } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            throw error;
        }
    }

    try {
        fs.unlinkSync(LOG_FILE);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    fs.appendFileSync(LOG_FILE, line);
}

export async function startAttack(onEvent = null, options = {}) {
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    // 새 데모 시작 시 이전 로그 초기화. worker는 tmp 디렉터리 소유자가 아닐 수 있으므로 삭제 대신 truncate한다.
    fs.writeFileSync(LOG_FILE, '');

    writeLog({ event: 'demo_started', targetDir: TARGET_DIR });

    const backup = {};

    for (let i = 1; i <= DEMO_FILE_COUNT; i++) {
        if (options.signal?.aborted) {
            fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
            writeLog({ event: 'demo_aborted', targetDir: TARGET_DIR });
            return { status: 'aborted', targetDir: TARGET_DIR };
        }

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

        } catch (error) {
            const blockReason = formatBlockReason(error, filePath);
            writeLog({
                event: 'demo_blocked_by_quarantine',
                blockedPath: filePath,
                index: i,
                reason: blockReason,
                errorCode: error?.code ?? null,
                errorMessage: error?.message ?? null
            });

            fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
            return {
                status: 'blocked',
                targetDir: TARGET_DIR,
                blockedPath: filePath,
                blockedIndex: i,
                reason: blockReason,
                errorCode: error?.code ?? null
            };
        }
    }

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    writeLog({ event: 'demo_completed', totalFiles: DEMO_FILE_COUNT });
    return { status: 'completed', targetDir: TARGET_DIR, totalFiles: DEMO_FILE_COUNT };
}

export function restoreDemo() {
    restoreDemoTargetPermissions();
    return restoreDemoEncryption(TARGET_DIR, { removeBackup: true });
}

export function restoreDemoEncryption(rootPath = TARGET_DIR, options = {}) {
    const resolvedRootPath = path.resolve(rootPath);

    if (!fs.existsSync(resolvedRootPath)) {
        return { restoredCount: 0, restoredFiles: [] };
    }

    const lockedPaths = findLockedFiles(resolvedRootPath);

    if (lockedPaths.length === 0) {
        return { restoredCount: 0, restoredFiles: [] };
    }

    writeLog({ event: 'restore_started', targetDir: resolvedRootPath });

    const restoredFiles = lockedPaths.map(lockedPath => {
        const originalPath = lockedPath.slice(0, -'.demo.locked'.length);
        const decodedContent = Buffer.from(fs.readFileSync(lockedPath, 'utf8'), 'base64').toString('utf8');

        fs.writeFileSync(lockedPath, decodedContent);
        fs.renameSync(lockedPath, originalPath);

        writeLog({
            event: 'file_restored',
            sourcePath: lockedPath,
            targetPath: originalPath
        });

        return originalPath;
    });

    if (options.removeBackup && fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE);
    writeLog({ event: 'restore_completed', targetDir: resolvedRootPath, totalFiles: restoredFiles.length });

    return {
        restoredCount: restoredFiles.length,
        restoredFiles
    };
}

export function resetDemo(options = {}) {
    return resetDemoWithOptions(options);
}

export function resetDemoWithOptions(options = {}) {
    const owner = normalizeOwner(options);
    restoreDemoTargetPermissions();
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    fs.mkdirSync(TARGET_DIR, { recursive: true, mode: DEMO_DIR_MODE });

    for (let i = 1; i <= DEMO_FILE_COUNT; i++) {
        const filePath = path.join(TARGET_DIR, `file_${i}.txt`);
        fs.writeFileSync(filePath, `original content ${i}`, { mode: DEMO_FILE_MODE });
    }

    restoreDemoTargetPermissions();
    applyDemoOwnership(TARGET_DIR, owner);

    if (fs.existsSync(BACKUP_FILE)) fs.unlinkSync(BACKUP_FILE);
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    writeLog({ event: 'demo_ready', targetDir: TARGET_DIR, totalFiles: DEMO_FILE_COUNT });
    applyDemoSupportFileOwnership(owner);

    return {
        status: 'ready',
        targetDir: TARGET_DIR,
        totalFiles: DEMO_FILE_COUNT
    };
}

function normalizeOwner(options = {}) {
    const ownerUid = Number(options.ownerUid);
    const ownerGid = Number(options.ownerGid);

    if (!Number.isInteger(ownerUid) || !Number.isInteger(ownerGid)) {
        return null;
    }

    return {
        uid: ownerUid,
        gid: ownerGid
    };
}

function applyDemoOwnership(rootPath, owner) {
    if (!owner || process.getuid?.() !== 0 || !fs.existsSync(rootPath)) {
        return;
    }

    chownRecursive(rootPath, owner);
}

function applyDemoSupportFileOwnership(owner) {
    if (!owner || process.getuid?.() !== 0) {
        return;
    }

    for (const filePath of [BACKUP_FILE, LOG_FILE]) {
        if (!fs.existsSync(filePath)) {
            continue;
        }

        try {
            fs.chownSync(filePath, owner.uid, owner.gid);
        } catch {
            // 로그/백업 파일은 worker 편의를 위한 best-effort 소유권 조정이다.
        }
    }
}

function chownRecursive(rootPath, owner) {
    try {
        fs.chownSync(rootPath, owner.uid, owner.gid);
    } catch {
        return;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);

        if (entry.isDirectory()) {
            chownRecursive(entryPath, owner);
            continue;
        }

        try {
            fs.chownSync(entryPath, owner.uid, owner.gid);
        } catch {
            // 일부 항목 실패는 데모 초기화 전체 실패로 처리하지 않는다.
        }
    }
}

function restoreDemoTargetPermissions(rootPath = TARGET_DIR) {
    if (!fs.existsSync(rootPath)) {
        return;
    }

    try {
        fs.chmodSync(rootPath, DEMO_DIR_MODE);
    } catch {
        return;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);

        if (entry.isDirectory()) {
            restoreDemoTargetPermissions(entryPath);
            continue;
        }

        if (entry.isFile()) {
            try {
                fs.chmodSync(entryPath, DEMO_FILE_MODE);
            } catch {
                // 권한 복구 실패 항목은 초기화 삭제 단계에서 force 처리에 맡긴다.
            }
        }
    }
}

function findLockedFiles(rootPath) {
    const lockedFiles = [];

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);

        if (entry.isDirectory()) {
            lockedFiles.push(...findLockedFiles(entryPath));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.demo.locked')) {
            lockedFiles.push(entryPath);
        }
    }

    return lockedFiles;
}

function formatBlockReason(error, filePath) {
    const code = error?.code;
    if (code === 'EACCES' || code === 'EPERM') {
        return `Permission denied (${code}) while writing ${filePath}`;
    }

    if (error?.message) {
        return `${error.message} (${filePath})`;
    }

    return `Quarantine blocked write access to ${filePath}`;
}

if (isDirectCliExecution()) {
    // CLI 실행 진입점
    const action = process.argv[2];
    if (action === 'run') {
        startAttack();
    } else if (action === 'restore') {
        restoreDemo();
    } else if (action === 'reset') {
        resetDemo();
    } else {
        console.log('Usage:');
        console.log('  node src/simulator/demo.js run      # Start attack simulation');
        console.log('  node src/simulator/demo.js restore  # Restore all files');
        console.log('  node src/simulator/demo.js reset    # Reset demo files');
    }
}

function isDirectCliExecution() {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
