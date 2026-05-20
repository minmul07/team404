import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('QuarantineService does not use mount-wide fuser cleanup', async () => {
  const source = await fs.readFile(
    path.resolve('src/isolation/quarantine-service.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /\bfuser\s+-m\b/);
});
