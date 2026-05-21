import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDetectionPolicy, normalizeExtension } from '../shared/config/detection-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_CATEGORIES_PATH = path.join(PROJECT_ROOT, 'ops/common-file-extensions.json');

const extensionCategories = JSON.parse(readFileSync(EXTENSION_CATEGORIES_PATH, 'utf8'));
const defaultKnownExtensions = buildDefaultKnownExtensions(extensionCategories);

let activeDetectionPolicy = normalizeDetectionPolicy();
let activeKnownExtensions = new Set([
  ...defaultKnownExtensions,
  ...activeDetectionPolicy.userAllowedExtensions
]);
let activeSuspiciousExtensions = new Set(activeDetectionPolicy.suspiciousExtensions);
let activeCustomExtensionWeights = new Map();

export function loadExtensionWeights(config = {}) {
  activeDetectionPolicy = normalizeDetectionPolicy(config.detectionPolicy ?? config);
  const customExtensionWeights = normalizeCustomExtensionWeights(config.customExtensionWeights);
  activeKnownExtensions = new Set([
    ...defaultKnownExtensions,
    ...activeDetectionPolicy.userAllowedExtensions
  ]);
  activeSuspiciousExtensions = new Set(activeDetectionPolicy.suspiciousExtensions);
  activeCustomExtensionWeights = customExtensionWeights;

  return {
    detectionPolicy: cloneDetectionPolicy(activeDetectionPolicy),
    customExtensionWeights: Object.fromEntries(activeCustomExtensionWeights)
  };
}

export function getExtensionWeight(ext) {
  const normalizedExtension = normalizeExtension(ext);

  if (!normalizedExtension) {
    return activeDetectionPolicy.weights.noExtension;
  }

  if (activeSuspiciousExtensions.has(normalizedExtension)) {
    return activeDetectionPolicy.weights.suspiciousExtension;
  }

  if (activeCustomExtensionWeights.has(normalizedExtension)) {
    return activeCustomExtensionWeights.get(normalizedExtension);
  }

  if (activeKnownExtensions.has(normalizedExtension)) {
    return activeDetectionPolicy.weights.knownExtension;
  }

  return activeDetectionPolicy.weights.unknownExtension;
}

export function getEventMultiplier(eventType) {
  return activeDetectionPolicy.eventMultipliers[eventType] ?? 1;
}

function buildDefaultKnownExtensions(categories) {
  const extensions = new Set();

  for (const categoryExtensions of Object.values(categories)) {
    for (const extension of categoryExtensions) {
      const normalizedExtension = normalizeExtension(extension);

      if (!normalizedExtension) {
        continue;
      }

      extensions.add(normalizedExtension);
    }
  }

  return extensions;
}

function normalizeCustomExtensionWeights(rawCustomExtensionWeights) {
  if (rawCustomExtensionWeights === undefined) {
    return new Map();
  }

  if (!rawCustomExtensionWeights || typeof rawCustomExtensionWeights !== 'object' || Array.isArray(rawCustomExtensionWeights)) {
    throw new Error('customExtensionWeights must be an object with numeric values');
  }

  const weights = new Map();

  for (const [extension, weight] of Object.entries(rawCustomExtensionWeights)) {
    if (!Number.isFinite(weight)) {
      throw new Error(`customExtensionWeights.${extension} must be a number`);
    }

    const normalizedExtension = normalizeExtension(extension);
    if (!normalizedExtension) {
      throw new Error('customExtensionWeights keys must be non-empty extensions');
    }

    weights.set(normalizedExtension, weight);
  }

  return weights;
}

function cloneDetectionPolicy(policy) {
  return {
    weights: { ...policy.weights },
    eventMultipliers: { ...policy.eventMultipliers },
    userAllowedExtensions: [...policy.userAllowedExtensions],
    suspiciousExtensions: [...policy.suspiciousExtensions]
  };
}
