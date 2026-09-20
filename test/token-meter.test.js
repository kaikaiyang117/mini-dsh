import assert from 'node:assert/strict'
import test from 'node:test'
import { TokenMeter } from '../src/core/token-meter.js'

test('TokenMeter includes system, messages, and Tool schemas', () => {
    const meter = new TokenMeter()
    const empty = meter.estimateRequest({})
    const system = meter.estimateRequest({ system: 'system instructions' })
    const messages = meter.estimateRequest({
        messages: [{ role: 'user', content: 'hello' }],
    })
    const tools = meter.estimateRequest({
        tools: [
            {
                type: 'function',
                function: { name: 'read', parameters: { type: 'object' } },
            },
        ],
    })
    const complete = meter.estimateRequest({
        system: 'system instructions',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
            {
                type: 'function',
                function: { name: 'read', parameters: { type: 'object' } },
            },
        ],
    })

    assert.equal(empty.tokens, 0)
    assert.ok(system.tokens > empty.tokens)
    assert.ok(messages.tokens > empty.tokens)
    assert.ok(tools.tokens > empty.tokens)
    assert.equal(complete.tokens, system.tokens + messages.tokens + tools.tokens)
})

test('TokenMeter heuristic is deterministic and provider-neutral', () => {
    const meter = new TokenMeter()
    const first = meter.estimateRequest({
        model: 'provider/model-a',
        system: 'system',
        messages: [{ content: 'hello', role: 'user' }],
        tools: [{ function: { parameters: { type: 'object' }, name: 'tool' } }],
    })
    const reordered = meter.estimateRequest({
        model: 'provider/model-b',
        system: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ function: { name: 'tool', parameters: { type: 'object' } } }],
    })

    assert.deepEqual(first, reordered)
    assert.equal(first.exact, false)
    assert.equal(first.method, 'heuristic-v1')
})

test('TokenMeter returns a stable zero estimate for an empty request', () => {
    assert.deepEqual(new TokenMeter().estimateRequest({}), {
        tokens: 0,
        exact: false,
        method: 'heuristic-v1',
    })
})

test('TokenMeter conservatively estimates Chinese text with heuristic-v1', () => {
    const meter = new TokenMeter()
    const estimate = meter.estimateRequest({ system: '中文测试' })

    assert.deepEqual(estimate, {
        tokens: 4,
        exact: false,
        method: 'heuristic-v1',
    })
    assert.deepEqual(meter.estimateRequest({ system: '中文测试' }), estimate)
})

test('TokenMeter deterministically estimates mixed Chinese and English text', () => {
    const meter = new TokenMeter()
    const request = {
        system: 'hello中文',
        messages: [{ role: 'user', content: '请 summarize this' }],
    }
    const first = meter.estimateRequest(request)
    const second = meter.estimateRequest(request)

    assert.deepEqual(second, first)
    assert.ok(first.tokens > 0)
    assert.equal(first.exact, false)
    assert.equal(first.method, 'heuristic-v1')
})
