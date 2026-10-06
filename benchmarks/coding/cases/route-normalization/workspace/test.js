import assert from 'node:assert/strict'; import test from 'node:test'; import { resolveApi } from './routes/api.js'; import { resolveAdmin } from './routes/admin.js'
test('all route groups use shared normalization', () => { assert.equal(resolveApi('/api//users/'), 'users'); assert.equal(resolveAdmin('//admin///users/'), 'users') })
