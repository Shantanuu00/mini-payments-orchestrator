#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

function genSecret() {
  return randomBytes(24).toString('hex');
}

const current = process.env.PROVIDER_WEBHOOK_SIGNING_SECRET ?? '';
const next = genSecret();
const merged = [current, next].filter(Boolean).join(',');

console.log('Suggested rotation update:');
console.log(`export PROVIDER_WEBHOOK_SIGNING_SECRET='${merged}'`);
console.log('After all producers use new secret, remove old and keep only the latest value.');
