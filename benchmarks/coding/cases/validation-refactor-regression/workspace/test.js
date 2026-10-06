import assert from 'node:assert/strict'; import test from 'node:test'; import { create } from './create.js'; import { update } from './update.js'
test('validates create and update', () => { assert.throws(() => create({})); assert.throws(() => update({ name: 'a' }, {})); assert.deepEqual(update({ name: 'a' }, { name: 'b' }), { name: 'b' }) })
