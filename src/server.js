import { once } from 'node:events';
import { parseRuntimeOptions } from './app/runtime-options.js';
import { createRuntime } from './app/runtime.js';
import { createApiServer } from './server/create-api-server.js';
import { loadAppConfig } from './shared/config/load-app-config.js';

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const { configPath } = parseRuntimeOptions(process.argv.slice(2));
  const config = await loadAppConfig({ configPath });
  const runtime = createRuntime(config);

  await runtime.start();

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
