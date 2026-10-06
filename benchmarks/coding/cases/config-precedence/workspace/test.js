import assert from 'node:assert/strict'; import test from 'node:test'; import { resolveConfig } from './config.js'
test('runtime wins over file and defaults', () => assert.deepEqual(resolveConfig({ port: 1, mode: 'd' }, { port: 2, mode: 'f' }, { port: 3 }), { port: 3, mode: 'f' }))
