export function parseRuntimeOptions(args) {
  const options = {
    configPath: undefined,
    withoutDashboard: false,
    demo: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--config') {
      options.configPath = readFlagValue(args, index, '--config');
      index += 1;
      continue;
    }

    if (arg === '--without-dashboard') {
      options.withoutDashboard = true;
      continue;
    }

    if (arg === '--demo') {
      options.demo = true;
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
