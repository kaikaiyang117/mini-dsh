import assert from 'node:assert/strict'; import test from 'node:test'; import { EventBus } from './events.js'
test('once fires once', () => { const b = new EventBus(); let calls = 0; b.once('x', () => calls++); b.emit('x'); b.emit('x'); assert.equal(calls, 1) })
