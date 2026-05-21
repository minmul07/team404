import test from 'node:test';
import assert from 'node:assert/strict';

import { getEventMultiplier, getExtensionWeight, loadExtensionWeights } from '../src/rules/extension-weight-loader.js';

test('loadExtensionWeights treats common extensions as allowlisted baseline', () => {
  loadExtensionWeights();

  assert.equal(getExtensionWeight('txt'), 0.1);
  assert.equal(getExtensionWeight('sh'), 0.1);
  assert.equal(getExtensionWeight('zip'), 0.1);
  assert.equal(getExtensionWeight('exe'), 0.1);
  assert.equal(getExtensionWeight('3ds'), 0.1);
});

test('loadExtensionWeights lets custom overrides replace defaults', () => {
  loadExtensionWeights({
    customExtensionWeights: {
      zip: 0.9,
      md: 0.05
    }
  });

  assert.equal(getExtensionWeight('zip'), 0.9);
  assert.equal(getExtensionWeight('md'), 0.05);
});

test('getExtensionWeight uses unknown weight for missing or unknown extensions', () => {
  loadExtensionWeights();

  assert.equal(getExtensionWeight('does-not-exist'), 1.0);
  assert.equal(getExtensionWeight(''), 1.0);
  assert.equal(getExtensionWeight(undefined), 1.0);
});

test('loadExtensionWeights applies user allowlist suspicious and event policy', () => {
  loadExtensionWeights({
    detectionPolicy: {
      weights: {
        knownExtension: 0.2,
        unknownExtension: 1.3,
        noExtension: 1.7,
        suspiciousExtension: 2.5
      },
      eventMultipliers: {
        create: 0.8,
        modify: 1.1,
        rename: 1.9
      },
      userAllowedExtensions: ['.backup'],
      suspiciousExtensions: ['locked']
    }
  });

  assert.equal(getExtensionWeight('backup'), 0.2);
  assert.equal(getExtensionWeight('unknown-ext'), 1.3);
  assert.equal(getExtensionWeight(''), 1.7);
  assert.equal(getExtensionWeight('locked'), 2.5);
  assert.equal(getEventMultiplier('create'), 0.8);
  assert.equal(getEventMultiplier('modify'), 1.1);
  assert.equal(getEventMultiplier('rename'), 1.9);
});
