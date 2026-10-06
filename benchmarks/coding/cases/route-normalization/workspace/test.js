import assert from 'node:assert/strict'; import test from 'node:test'; import { normalizeRoute } from './route.js'
test('normalizes route', () => { assert.equal(normalizeRoute('//users///42/'), '/users/42'); assert.equal(normalizeRoute('/'), '/') })
