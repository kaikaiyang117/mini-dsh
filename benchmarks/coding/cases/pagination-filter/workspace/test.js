import assert from 'node:assert/strict'; import test from 'node:test'; import { listItems } from './list.js'
test('filters before paginating', () => { const items = [{ id: 1, status: 'open' }, { id: 2, status: 'closed' }, { id: 3, status: 'open' }]; assert.deepEqual(listItems(items, { status: 'open', offset: 1, limit: 1 }), [{ id: 3, status: 'open' }]) })
