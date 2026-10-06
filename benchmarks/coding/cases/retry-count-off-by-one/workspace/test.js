import assert from 'node:assert/strict'; import test from 'node:test'; import { runWithRetry } from './retry.js'
test('allows the initial attempt plus retries', async () => { let calls = 0; const value = await runWithRetry(async () => { calls++; if (calls < 3) throw Error('wait'); return 'ok' }, 2); assert.equal(value, 'ok'); assert.equal(calls, 3) })
