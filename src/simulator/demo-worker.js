import { normalizeDemoFileCount, startAttack } from './demo.js';

const controller = new AbortController();
const fileCount = normalizeDemoFileCount(process.env.DEMO_FILE_COUNT);

process.on('message', (message) => {
    if (message?.type === 'abort') {
        controller.abort();
    }
});

runWorker();

async function runWorker() {
    try {
        const result = await startAttack((eventType, filePath) => {
            sendMessage({
                type: 'fs_event',
                payload: {
                    eventType,
                    filePath
                }
            });
        }, { signal: controller.signal, fileCount });

        await sendMessage({
            type: result?.status ?? 'completed',
            payload: result ?? {}
        });
        process.exitCode = 0;
    } catch (error) {
        await sendMessage({
            type: 'error',
            payload: {
                message: error.message,
                stack: error.stack
            }
        });
        process.exitCode = 1;
    } finally {
        process.disconnect?.();
    }
}

function sendMessage(message) {
    return new Promise((resolve) => {
        if (!process.send || !process.connected) {
            resolve(false);
            return;
        }

        process.send(message, () => resolve(true));
    });
}
