import assert from 'node:assert/strict'
import test from 'node:test'
import { clamp } from './calculator.js'
test('clamps both boundaries', () => { assert.equal(clamp(-2, 0, 10), 0); assert.equal(clamp(5, 0, 10), 5); assert.equal(clamp(12, 0, 10), 10) })
