import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DETECTABLE_FILE_EVENT_TYPES } from '../contracts/event-names.js';
import { normalizeDetectionPolicy } from './detection-policy.js';
import { normalizeDemoFileCount } from '../../simulator/demo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'ops/sample-config/app-config.json');

export async function loadAppConfig(options = {}) {
  const normalizedOptions = normalizeLoadOptions(options);
  const resolvedConfigPath = path.resolve(
    normalizedOptions.configPath ?? process.env.APP_CONFIG ?? DEFAULT_CONFIG_PATH
  );
  const configDir = path.dirname(resolvedConfigPath);
  const raw = await readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw);

  const monitorTargets = normalizeMonitorTargets(parsed.monitor?.targets, configDir);
  const normalizedRules = normalizeRules(parsed.rules);
  const customExtensionWeights = normalizeCustomExtensionWeights(parsed.customExtensionWeights);
  const detectionPolicy = normalizeDetectionPolicy(parsed.detectionPolicy);

  const config = {
    server: {
      host: parsed.server?.host ?? '127.0.0.1',
      port: parsed.server?.port ?? 3000
    },
    monitor: {
      scriptPath: resolveFromConfig(configDir, parsed.monitor?.scriptPath ?? '../config/monitor.sh'),
      restartDelayMs: parsed.monitor?.restartDelayMs ?? 2000,
      movePairWindowMs: parsed.monitor?.movePairWindowMs ?? 750,
      targets: monitorTargets
    },
    rules: {
      definitions: normalizedRules
    },
    detectionPolicy,
    customExtensionWeights,
    demo: normalizeDemoConfig(parsed.demo),
    meta: {
      configPath: resolvedConfigPath,
      configDir,
      projectRoot: PROJECT_ROOT
    }
  };

  validateConfig(config);
  return config;
}

function normalizeLoadOptions(options) {
  if (typeof options === 'string') {
    return { configPath: options };
  }

  return {
    configPath: options.configPath
  };
}

function normalizeMonitorTargets(rawTargets, configDir) {
  return (rawTargets ?? []).map((target, index) => ({
    id: target?.id ?? `target-${index + 1}`,
    rootPath: resolveFromConfig(configDir, target.rootPath),
    enabled: target?.enabled ?? true,
    autoQuarantineEnabled: target?.autoQuarantineEnabled ?? false,
    demoAllowed: target?.demoAllowed ?? false
  }));
}

function normalizeRules(rawRules) {
  if (Array.isArray(rawRules)) {
    return rawRules.map((rule, index) => normalizeRuleDefinition(rule, index));
  }

  return [];
}

function normalizeCustomExtensionWeights(rawCustomExtensionWeights) {
  if (rawCustomExtensionWeights === undefined) {
    return undefined;
  }

  if (
    !rawCustomExtensionWeights ||
    typeof rawCustomExtensionWeights !== 'object' ||
    Array.isArray(rawCustomExtensionWeights)
  ) {
    throw new Error('customExtensionWeights must be an object with numeric values');
  }

  const normalizedWeights = {};

  for (const [extension, weight] of Object.entries(rawCustomExtensionWeights)) {
    if (!Number.isFinite(weight)) {
      throw new Error(`customExtensionWeights.${extension} must be a number`);
    }

    normalizedWeights[extension] = weight;
  }

  return normalizedWeights;
}

function normalizeDemoConfig(rawDemoConfig = {}) {
  const runAsUid = normalizeOptionalNonNegativeInteger(rawDemoConfig.runAsUid, 'demo.runAsUid');
  const runAsGid = normalizeOptionalNonNegativeInteger(rawDemoConfig.runAsGid, 'demo.runAsGid');
  const demo = {
    fileCount: normalizeDemoFileCount(rawDemoConfig.fileCount)
  };

  if (runAsUid !== undefined) {
    demo.runAsUid = runAsUid;
  }

  if (runAsGid !== undefined) {
    demo.runAsGid = runAsGid;
  }

  return demo;
}

function normalizeOptionalNonNegativeInteger(value, key) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return numberValue;
}

function normalizeRuleDefinition(rule, index) {
  return {
    ruleId: rule?.ruleId ?? `rule-${index + 1}`,
    ruleName: rule?.ruleName ?? `${capitalize(rule?.eventType ?? 'unknown')} Burst`,
    eventType: rule?.eventType,
    severity: rule?.severity ?? 'high',
    autoQuarantine: Boolean(rule?.autoQuarantine)
  };
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

  if (Array.isArray(config.rules.definitions)) {
    const seenRuleIds = new Set();
    for (const rule of config.rules.definitions) {
      if (seenRuleIds.has(rule.ruleId)) {
        throw new Error(`Duplicate ruleId: ${rule.ruleId}`);
      }

      if (!DETECTABLE_FILE_EVENT_TYPES.includes(rule.eventType)) {
        throw new Error(`Unsupported rule eventType: ${rule.eventType}`);
      }

      seenRuleIds.add(rule.ruleId);
    }
  }

  assertPositiveInteger(config.server.port, 'server.port');
  assertPositiveInteger(config.monitor.restartDelayMs, 'monitor.restartDelayMs');
  assertPositiveInteger(config.monitor.movePairWindowMs, 'monitor.movePairWindowMs');
}

function assertPositiveInteger(value, key) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
}

function capitalize(value) {
  if (!value) {
    return 'Unknown';
  }

  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
