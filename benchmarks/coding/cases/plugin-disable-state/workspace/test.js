import assert from 'node:assert/strict'; import test from 'node:test'; import { Registry } from './registry.js'; import { run } from './runner.js'
test('disabled plugin is skipped', () => { const r = new Registry(); r.enable('p'); let calls = 0; const p = { name: 'p', run: () => ++calls }; r.disable('p'); assert.equal(run(r, p), undefined); assert.equal(calls, 0) })
