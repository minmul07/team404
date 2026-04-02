import { once } from 'node:events';

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

  const shutdownSignals = ['SIGINT', 'SIGTERM'];
  for (const signal of shutdownSignals) {
    process.once(signal, async () => {
      server.close();
      await runtime.stop();
      process.exit(0);
    });
  }

  await once(server, 'close');
}

function parseRuntimeOptions(args) {
  const options = {
    configPath: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--config') {
      options.configPath = readFlagValue(args, index, '--config');
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readFlagValue(args, index, flagName) {
  const nextValue = args[index + 1];
  if (!nextValue || nextValue.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }

  return nextValue;
}
