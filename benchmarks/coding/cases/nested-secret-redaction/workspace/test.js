import assert from 'node:assert/strict'; import test from 'node:test'; import { redact } from './redact.js'
test('redacts nested values', () => assert.deepEqual(redact({ user: { token: 'x' }, list: [{ password: 'y' }] }), { user: { token: '[REDACTED]' }, list: [{ password: '[REDACTED]' }] }))
