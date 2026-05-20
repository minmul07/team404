import test from 'node:test';
import assert from 'node:assert/strict';

import { getExtensionWeight, loadExtensionWeights } from '../src/rules/extension-weight-loader.js';

test('loadExtensionWeights applies default category weights and lowest shared-category weight wins', () => {
  loadExtensionWeights();

  assert.equal(getExtensionWeight('txt'), 0.1);
  assert.equal(getExtensionWeight('sh'), 0.1);
  assert.equal(getExtensionWeight('zip'), 0.3);
  assert.equal(getExtensionWeight('exe'), 0.5);
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
