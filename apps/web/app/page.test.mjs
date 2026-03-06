import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard page includes key demo scenario labels', async () => {
  const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('Duplicate Confirm Replay'), true);
  assert.equal(source.includes('Webhook Dedupe Demo'), true);
});
