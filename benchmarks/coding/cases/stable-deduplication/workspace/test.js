import assert from 'node:assert/strict'; import test from 'node:test'; import { dedupe } from './dedupe.js'
test('keeps first occurrence order', () => assert.deepEqual(dedupe(['b', 'a', 'b', 'c']), ['b', 'a', 'c']))
