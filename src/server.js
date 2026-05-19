import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';

import { attachConsoleEventLogger } from './app/console-event-logger.js';
import { parseRuntimeOptions } from './app/runtime-options.js';
import { createRuntime } from './app/runtime.js';
import { createApiServer } from './server/create-api-server.js';
import { loadAppConfig } from './shared/config/load-app-config.js';

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const { configPath, withoutDashboard, demo } = parseRuntimeOptions(process.argv.slice(2));
  const config = await loadAppConfig({ configPath });
  const runtime = createRuntime(config, {
    watchOptions: {
      demo
    }
  });
  let detachConsoleEventLogger = null;

  if (withoutDashboard) {
    detachConsoleEventLogger = attachConsoleEventLogger({ eventBus: runtime.eventBus });
  }

  await runtime.start();

  if (withoutDashboard) {
    console.log(
      `dashboard disabled; streaming fs_event logs using ${config.meta.configPath}${demo ? ' in demo mode' : ''}`
    );
    registerShutdownHandlers({
      async onShutdown() {
        detachConsoleEventLogger?.();
        await runtime.stop();
      }
    });
    await new Promise(() => {});
    return;
  }

  const server = createApiServer({ runtime });

  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `server listening on http://${config.server.host}:${config.server.port} using ${config.meta.configPath}`
    );
  });

  registerShutdownHandlers({
    async onShutdown() {
      server.close();
      await runtime.stop();
    }
  });

  await once(server, 'close');
}

function registerShutdownHandlers({ onShutdown }) {
  const shutdownSignals = ['SIGINT', 'SIGTERM'];
  let isShuttingDown = false;

  for (const signal of shutdownSignals) {
    process.once(signal, async () => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      await onShutdown();
      process.exit(0);
    });
  }
}

export function createStandaloneDemoServer() {
  const runtime = {
    async getSnapshot() {
      return {
        activeTarget: '/home/bangjyuhyeon/team404',
        quarantineJobs: [{ incidentId: 'demo-001', rootPath: '/test', entryCount: 1 }]
      };
    }
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    let filePath = '';
    if (url.pathname === '/' || url.pathname === '/index.html') filePath = './public/index.html';
    else if (url.pathname === '/style.css') filePath = './public/style.css';
    else if (url.pathname === '/app.js') filePath = './public/app.js';

    if (filePath) {
      try {
        const content = await fs.readFile(filePath);
        response.end(content);
        return;
      } catch (e) { }
    }

    if (url.pathname === '/api/snapshot') {
      const data = await runtime.getSnapshot();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    }
  });
}
