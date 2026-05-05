import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_DIR = path.resolve(__dirname, '../../tmp/demo-target');

// 원본 파일 내용 백업 저장소 (복구 시 사용)
const backup = {};

export async function startAttack() {
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    console.log(`[DEMO] Attack simulation started`);
    console.log(`[DEMO] Target directory: ${TARGET_DIR}`);
    console.log(`[DEMO] ----------------------------------------`);

    for (let i = 1; i <= 15; i++) {
        const filePath = path.join(TARGET_DIR, `file_${i}.txt`);
        const lockedPath = filePath + '.demo.locked';

        try {
            // 원본 내용 백업
            const originalContent = fs.existsSync(filePath)
                ? fs.readFileSync(filePath, 'utf8')
                : `original content ${i}`;
            backup[`file_${i}.txt`] = originalContent;

            // Base64 인코딩으로 파일 내용 변조
            const encoded = Buffer.from(originalContent).toString('base64');
            fs.writeFileSync(filePath, encoded);

            // 확장자 변경으로 랜섬웨어 패턴 시뮬레이션
            fs.renameSync(filePath, lockedPath);

            console.log(`[DEMO] Encrypted: file_${i}.txt -> file_${i}.txt.demo.locked (${i}/15)`);

            // inotifywait 감지를 위한 100ms 간격 유지
            await new Promise(res => setTimeout(res, 100));

        } catch (error) {
            console.error(`[DEMO] Access denied: file_${i}.txt`);
            console.error(`[DEMO] Quarantine is active. Further modification blocked.`);
            return;
        }
    }

    console.log(`[DEMO] ----------------------------------------`);
    console.log(`[DEMO] Simulation complete. Awaiting detection response.`);
}

export function restoreDemo() {
    if (!fs.existsSync(TARGET_DIR)) {
        console.log('[RESTORE] Target directory not found. Nothing to restore.');
        return;
    }

    console.log('[RESTORE] Starting file restoration...');
    console.log('[RESTORE] ----------------------------------------');

    fs.readdirSync(TARGET_DIR).forEach(file => {
        if (file.endsWith('.demo.locked')) {
            const lockedPath = path.join(TARGET_DIR, file);
            const originalName = file.replace('.demo.locked', '');
            const originalPath = path.join(TARGET_DIR, originalName);

            // 원본 내용 및 파일명 복구
            const originalContent = backup[originalName] || 'original content';
            fs.writeFileSync(lockedPath, originalContent);
            fs.renameSync(lockedPath, originalPath);

            console.log(`[RESTORE] Recovered: ${file} -> ${originalName}`);
        }
    });

    console.log('[RESTORE] ----------------------------------------');
    console.log('[RESTORE] All files restored successfully.');
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