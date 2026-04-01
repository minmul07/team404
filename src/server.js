import { once } from 'node:events';

import { createRuntime } from './app/runtime.js';
import { createApiServer } from './server/create-api-server.js';
import { loadAppConfig } from './shared/config/load-app-config.js';

const config = await loadAppConfig();
const runtime = createRuntime(config);
await runtime.start();

const server = createApiServer({ runtime });

server.listen(config.server.port, config.server.host, () => {
  console.log(
    `server listening on http://${config.server.host}:${config.server.port} using ${config.meta.configPath}`
  );
});

const shutdownSignals = ['SIGINT', 'SIGTERM'];
for (const signal of shutdownSignals) {
  process.once(signal, async () => {
    server.close();
    await runtime.stop();
    process.exit(0);
  });
}

await once(server, 'close');
