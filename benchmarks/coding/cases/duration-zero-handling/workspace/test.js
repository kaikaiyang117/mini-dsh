import assert from 'node:assert/strict'; import test from 'node:test'; import { normalize } from './options.js'
test('preserves zero', () => { assert.equal(normalize({ duration: 0 }).duration, 0); assert.equal(normalize({}).duration, 1000) })
