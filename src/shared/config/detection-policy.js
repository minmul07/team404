import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_DETECTION_POLICY_PATH = path.join(PROJECT_ROOT, 'ops/default-detection-policy.json');

const BUILTIN_DETECTION_POLICY = Object.freeze({
  thresholdWeight: 10,
  weights: Object.freeze({
    knownExtension: 0.1,
    unknownExtension: 1.0,
    noExtension: 1.0,
    suspiciousExtension: 2.0
  }),
  eventMultipliers: Object.freeze({
    create: 1.0,
    modify: 1.0,
    rename: 1.5
  }),
  weightDecay: Object.freeze({
    intervalMs: 1000,
    amount: 1.0
  }),
  userAllowedExtensions: Object.freeze([]),
  suspiciousExtensions: Object.freeze([
    'locked',
    'encrypted',
    'warning',
    'decrypt',
    'ransom',
    'recover',
    'pay'
  ])
});

export const DEFAULT_DETECTION_POLICY = deepFreeze(
  normalizeDetectionPolicyShape(readDefaultDetectionPolicy(), BUILTIN_DETECTION_POLICY)
);

export function normalizeDetectionPolicy(rawPolicy = {}) {
  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    throw new Error('detectionPolicy must be an object');
  }

  return normalizeDetectionPolicyShape(rawPolicy, DEFAULT_DETECTION_POLICY);
}

export function getDefaultDetectionPolicy() {
  return cloneDetectionPolicy(DEFAULT_DETECTION_POLICY);
}

export function normalizeExtensionList(rawExtensions, fallback, fieldName) {
  if (rawExtensions === undefined) {
    return [...fallback];
  }

  if (!Array.isArray(rawExtensions)) {
    throw new Error(`${fieldName} must be an array`);
  }

  const extensions = [];
  const seen = new Set();

  for (const extension of rawExtensions) {
    const normalized = normalizeExtension(extension);
    if (!normalized) {
      throw new Error(`${fieldName} entries must be non-empty extensions`);
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      extensions.push(normalized);
    }
  }

  return extensions;
}

export function normalizeExtension(ext) {
  if (typeof ext !== 'string') {
    return '';
  }

  const trimmed = ext.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.startsWith('.') ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}

function normalizeDetectionPolicyShape(policy, fallback) {
  return {
    thresholdWeight: normalizePositiveNumber(
      policy.thresholdWeight,
      fallback.thresholdWeight,
      'detectionPolicy.thresholdWeight'
    ),
    weights: {
      knownExtension: normalizeNonNegativeNumber(
        policy.weights?.knownExtension,
        fallback.weights.knownExtension,
        'detectionPolicy.weights.knownExtension'
      ),
      unknownExtension: normalizeNonNegativeNumber(
        policy.weights?.unknownExtension,
        fallback.weights.unknownExtension,
        'detectionPolicy.weights.unknownExtension'
      ),
      noExtension: normalizeNonNegativeNumber(
        policy.weights?.noExtension,
        fallback.weights.noExtension,
        'detectionPolicy.weights.noExtension'
      ),
      suspiciousExtension: normalizeNonNegativeNumber(
        policy.weights?.suspiciousExtension,
        fallback.weights.suspiciousExtension,
        'detectionPolicy.weights.suspiciousExtension'
      )
    },
    eventMultipliers: {
      create: normalizeNonNegativeNumber(
        policy.eventMultipliers?.create,
        fallback.eventMultipliers.create,
        'detectionPolicy.eventMultipliers.create'
      ),
      modify: normalizeNonNegativeNumber(
        policy.eventMultipliers?.modify,
        fallback.eventMultipliers.modify,
        'detectionPolicy.eventMultipliers.modify'
      ),
      rename: normalizeNonNegativeNumber(
        policy.eventMultipliers?.rename,
        fallback.eventMultipliers.rename,
        'detectionPolicy.eventMultipliers.rename'
      )
    },
    weightDecay: {
      intervalMs: normalizePositiveInteger(
        policy.weightDecay?.intervalMs,
        fallback.weightDecay.intervalMs,
        'detectionPolicy.weightDecay.intervalMs'
      ),
      amount: normalizeNonNegativeNumber(
        policy.weightDecay?.amount,
        fallback.weightDecay.amount,
        'detectionPolicy.weightDecay.amount'
      )
    },
    userAllowedExtensions: normalizeExtensionList(
      policy.userAllowedExtensions,
      fallback.userAllowedExtensions,
      'detectionPolicy.userAllowedExtensions'
    ),
    suspiciousExtensions: normalizeExtensionList(
      policy.suspiciousExtensions,
      fallback.suspiciousExtensions,
      'detectionPolicy.suspiciousExtensions'
    )
  };
}

function readDefaultDetectionPolicy() {
  try {
    return JSON.parse(readFileSync(DEFAULT_DETECTION_POLICY_PATH, 'utf8'));
  } catch {
    return BUILTIN_DETECTION_POLICY;
  }
}

function normalizeNonNegativeNumber(value, fallback, fieldName) {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }

  return value;
}

function normalizePositiveNumber(value, fallback, fieldName) {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }

  return value;
}

function normalizePositiveInteger(value, fallback, fieldName) {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value;
}

function cloneDetectionPolicy(policy) {
  return {
    thresholdWeight: policy.thresholdWeight,
    weights: { ...policy.weights },
    eventMultipliers: { ...policy.eventMultipliers },
    weightDecay: { ...policy.weightDecay },
    userAllowedExtensions: [...policy.userAllowedExtensions],
    suspiciousExtensions: [...policy.suspiciousExtensions]
  };
}

function deepFreeze(policy) {
  Object.freeze(policy.weights);
  Object.freeze(policy.eventMultipliers);
  Object.freeze(policy.weightDecay);
  Object.freeze(policy.userAllowedExtensions);
  Object.freeze(policy.suspiciousExtensions);
  return Object.freeze(policy);
}
