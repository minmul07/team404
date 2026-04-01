import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'ops/sample-config/app-config.json');

export async function loadAppConfig(configPath = process.env.APP_CONFIG || DEFAULT_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(configPath);
  const configDir = path.dirname(resolvedConfigPath);
  const raw = await readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw);

  const config = {
    server: {
      host: parsed.server?.host ?? '127.0.0.1',
      port: parsed.server?.port ?? 3000
    },
    monitor: {
      scriptPath: resolveFromConfig(configDir, parsed.monitor?.scriptPath ?? '../config/monitor.sh'),
      restartDelayMs: parsed.monitor?.restartDelayMs ?? 2000,
      movePairWindowMs: parsed.monitor?.movePairWindowMs ?? 750,
      targets: (parsed.monitor?.targets ?? []).map((target) => ({
        id: target.id,
        rootPath: resolveFromConfig(configDir, target.rootPath)
      }))
    },
    rules: {
      burstWindowMs: parsed.rules?.burstWindowMs ?? 10000,
      burstThreshold: parsed.rules?.burstThreshold ?? 5,
      incidentCooldownMs: parsed.rules?.incidentCooldownMs ?? 15000
    },
    meta: {
      configPath: resolvedConfigPath,
      configDir,
      projectRoot: PROJECT_ROOT
    }
  };

  validateConfig(config);
  return config;
}

function resolveFromConfig(configDir, targetPath) {
  return path.resolve(configDir, targetPath);
}

function validateConfig(config) {
  if (!Array.isArray(config.monitor.targets) || config.monitor.targets.length === 0) {
    throw new Error('monitor.targets must include at least one target');
  }

  for (const target of config.monitor.targets) {
    if (!target.id || !target.rootPath) {
      throw new Error('Each monitor target requires id and rootPath');
    }
  }

  assertPositiveInteger(config.server.port, 'server.port');
  assertPositiveInteger(config.monitor.restartDelayMs, 'monitor.restartDelayMs');
  assertPositiveInteger(config.monitor.movePairWindowMs, 'monitor.movePairWindowMs');
  assertPositiveInteger(config.rules.burstWindowMs, 'rules.burstWindowMs');
  assertPositiveInteger(config.rules.burstThreshold, 'rules.burstThreshold');
  assertPositiveInteger(config.rules.incidentCooldownMs, 'rules.incidentCooldownMs');
}

function assertPositiveInteger(value, key) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
}
