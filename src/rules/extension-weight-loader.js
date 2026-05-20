import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_CATEGORIES_PATH = path.join(PROJECT_ROOT, 'ops/common-file-extensions.json');

const CATEGORY_WEIGHTS = Object.freeze({
  code: 0.1,
  text: 0.1,
  web: 0.1,
  image: 0.1,
  audio: 0.1,
  video: 0.1,
  sheet: 0.1,
  slide: 0.1,
  book: 0.1,
  '3D': 0.1,
  font: 0.1,
  archive: 0.3,
  exec: 0.5,
  unknown: 1.0
});

const DEFAULT_UNKNOWN_WEIGHT = CATEGORY_WEIGHTS.unknown;

const extensionCategories = JSON.parse(readFileSync(EXTENSION_CATEGORIES_PATH, 'utf8'));
const defaultWeights = buildDefaultExtensionWeights(extensionCategories);

let activeExtensionWeights = new Map(defaultWeights);

export function loadExtensionWeights(config = {}) {
  const customExtensionWeights = normalizeCustomExtensionWeights(config.customExtensionWeights);
  activeExtensionWeights = new Map(defaultWeights);

  for (const [extension, weight] of customExtensionWeights) {
    activeExtensionWeights.set(extension, weight);
  }

  return Object.fromEntries(activeExtensionWeights);
}

export function getExtensionWeight(ext) {
  const normalizedExtension = normalizeExtension(ext);

  if (!normalizedExtension) {
    return DEFAULT_UNKNOWN_WEIGHT;
  }

  return activeExtensionWeights.get(normalizedExtension) ?? DEFAULT_UNKNOWN_WEIGHT;
}

function buildDefaultExtensionWeights(categories) {
  const weights = new Map();

  for (const [category, extensions] of Object.entries(categories)) {
    const categoryWeight = CATEGORY_WEIGHTS[category] ?? DEFAULT_UNKNOWN_WEIGHT;

    for (const extension of extensions) {
      const normalizedExtension = normalizeExtension(extension);

      if (!normalizedExtension) {
        continue;
      }

      const existingWeight = weights.get(normalizedExtension);
      if (existingWeight === undefined || categoryWeight < existingWeight) {
        weights.set(normalizedExtension, categoryWeight);
      }
    }
  }

  return weights;
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

function normalizeExtension(ext) {
  if (typeof ext !== 'string') {
    return '';
  }

  const trimmed = ext.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.startsWith('.') ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}
