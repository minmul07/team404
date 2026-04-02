import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DETECTABLE_FILE_EVENT_TYPES } from '../contracts/event-names.js';

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

  if (rawRules && typeof rawRules === 'object') {
    return DETECTABLE_FILE_EVENT_TYPES.map((eventType, index) =>
      normalizeRuleDefinition(
        {
          ruleId: `burst-${eventType}`,
          ruleName: `${capitalize(eventType)} Burst`,
          eventType,
          threshold: rawRules.burstThreshold,
          windowMs: rawRules.burstWindowMs,
          incidentCooldownMs: rawRules.incidentCooldownMs,
          severity: rawRules.severity,
          autoQuarantine: rawRules.autoQuarantine
        },
        index
      )
    );
  }

  return [];
}

function normalizeRuleDefinition(rule, index) {
  return {
    ruleId: rule?.ruleId ?? `rule-${index + 1}`,
    ruleName: rule?.ruleName ?? `${capitalize(rule?.eventType ?? 'unknown')} Burst`,
    eventType: rule?.eventType,
    threshold: rule?.threshold ?? 5,
    windowMs: rule?.windowMs ?? 10000,
    incidentCooldownMs: rule?.incidentCooldownMs ?? 15000,
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

  if (!Array.isArray(config.rules.definitions) || config.rules.definitions.length === 0) {
    throw new Error('rules must include at least one definition');
  }

  const seenRuleIds = new Set();
  for (const rule of config.rules.definitions) {
    if (seenRuleIds.has(rule.ruleId)) {
      throw new Error(`Duplicate ruleId: ${rule.ruleId}`);
    }

    if (!DETECTABLE_FILE_EVENT_TYPES.includes(rule.eventType)) {
      throw new Error(`Unsupported rule eventType: ${rule.eventType}`);
    }

    assertPositiveInteger(rule.threshold, `rules.${rule.ruleId}.threshold`);
    assertPositiveInteger(rule.windowMs, `rules.${rule.ruleId}.windowMs`);
    assertPositiveInteger(
      rule.incidentCooldownMs,
      `rules.${rule.ruleId}.incidentCooldownMs`
    );

    seenRuleIds.add(rule.ruleId);
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
