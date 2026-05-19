import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRuntimeOptions } from '../src/app/runtime-options.js';

test('parseRuntimeOptions reads config path', () => {
  assert.deepEqual(parseRuntimeOptions(['--config', './config/local.json']), {
    configPath: './config/local.json'
  });
});

test('parseRuntimeOptions warns and ignores unknown arguments', () => {
  const warnings = [];
  const originalWarn = console.warn;

  console.warn = (message) => {
    warnings.push(message);
  };

  try {
    assert.deepEqual(parseRuntimeOptions(['--unknown', '--config', './config/local.json']), {
      configPath: './config/local.json'
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, ['Unknown argument: --unknown']);
});
