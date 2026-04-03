import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRuntimeOptions } from '../src/app/runtime-options.js';

test('parseRuntimeOptions enables headless logging with --without-dashboard', () => {
  assert.deepEqual(parseRuntimeOptions(['--without-dashboard']), {
    configPath: undefined,
    withoutDashboard: true,
    demo: false
  });
});

test('parseRuntimeOptions reads config path, headless flag, and demo flag together', () => {
  assert.deepEqual(
    parseRuntimeOptions(['--config', './config/local.json', '--without-dashboard', '--demo']),
    {
      configPath: './config/local.json',
      withoutDashboard: true,
      demo: true
    }
  );
});

test('parseRuntimeOptions enables demo mode independently', () => {
  assert.deepEqual(parseRuntimeOptions(['--demo']), {
    configPath: undefined,
    withoutDashboard: false,
    demo: true
  });
});

test('parseRuntimeOptions rejects unknown arguments', () => {
  assert.throws(() => parseRuntimeOptions(['--unknown']), /Unknown argument: --unknown/);
});
