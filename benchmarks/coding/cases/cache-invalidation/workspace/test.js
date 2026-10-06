import assert from 'node:assert/strict'; import test from 'node:test'; import { Cache } from './cache.js'; import { Repository } from './repository.js'
test('refreshes cached entries after writes', () => { const cache = new Cache(); const repo = new Repository(cache); repo.set('x', 1); assert.equal(repo.get('x'), 1); repo.set('x', 2); assert.equal(repo.get('x'), 2) })
