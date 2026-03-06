import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('worker config includes bounded retries and backoff schedule', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('const MAX_DELIVERY_ATTEMPTS = 8;'), true);
  assert.equal(source.includes('const DELIVERY_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];'), true);
});
