import assert from 'node:assert/strict'; import test from 'node:test'; import { Store } from './store.js'
test('removes old name index', () => { const s = new Store(); s.add({ id: 1, name: 'old' }); s.rename(1, 'new'); assert.equal(s.findByName('old'), undefined); assert.equal(s.findByName('new').id, 1) })
