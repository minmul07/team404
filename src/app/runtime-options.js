export function parseRuntimeOptions(args) {
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

    if (arg.startsWith('--')) {
      console.warn(`Unknown argument: ${arg}`);
      continue;
    }

    console.warn(`Unknown argument: ${arg}`);
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
