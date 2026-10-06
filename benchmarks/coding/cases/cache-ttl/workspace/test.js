import assert from 'node:assert/strict'; import test from 'node:test'; import { Cache } from './cache.js'
test('expires values after ttl', () => { let now = 0; const c = new Cache({ now: () => now }); c.set('x', 1, 10); now = 11; assert.equal(c.get('x'), undefined) })
