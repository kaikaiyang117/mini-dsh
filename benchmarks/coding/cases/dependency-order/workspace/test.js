import assert from 'node:assert/strict'; import test from 'node:test'; import { dependencyOrder } from './order.js'
test('dependencies precede consumers', () => { const result = dependencyOrder({ app: ['db'], db: [] }); assert.ok(result.indexOf('db') < result.indexOf('app')) })
