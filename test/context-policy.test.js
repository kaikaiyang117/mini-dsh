import assert from 'node:assert/strict'
import test from 'node:test'
import { measureContextPressure, normalizeContextPolicy } from '../src/core/context-policy.js'

test('ContextPolicy validates window, output reservation, ratio, and available input', () => {
    for (const maxContextTokens of [0, -1, 1.5, Number.POSITIVE_INFINITY, '100']) {
        assert.throws(() => normalizeContextPolicy({ maxContextTokens }), /positive integer/)
    }
    for (const reservedOutputTokens of [null, -1, 1.5, Number.POSITIVE_INFINITY, '10']) {
        assert.throws(
            () => normalizeContextPolicy({ reservedOutputTokens }),
            /non-negative integer/,
        )
    }
    for (const compactAtRatio of [null, 0, -0.1, 1.1, Number.NaN, '0.8']) {
        assert.throws(() => normalizeContextPolicy({ compactAtRatio }), /greater than 0/)
    }
    assert.throws(
        () => normalizeContextPolicy({ maxContextTokens: 100, reservedOutputTokens: 100 }),
        /less than maxContextTokens/,
    )
    assert.throws(
        () => normalizeContextPolicy({ maxContextTokens: 100, reservedOutputTokens: 101 }),
        /less than maxContextTokens/,
    )
})

test('Context pressure distinguishes normal, exact soft, soft, exact hard, and hard limits', () => {
    const policy = {
        maxContextTokens: 100,
        reservedOutputTokens: 20,
        compactAtRatio: 0.75,
    }

    assert.equal(measureContextPressure(59, policy).state, 'normal')
    assert.equal(measureContextPressure(60, policy).state, 'soft_limit')
    assert.equal(measureContextPressure(70, policy).state, 'soft_limit')
    assert.equal(measureContextPressure(80, policy).state, 'hard_limit')
    assert.equal(measureContextPressure(90, policy).state, 'hard_limit')
    assert.deepEqual(measureContextPressure(60, policy), {
        state: 'soft_limit',
        maxContextTokens: 100,
        availableInputTokens: 80,
        softLimitTokens: 60,
    })
})

test('Context pressure is disabled when maxContextTokens is null', () => {
    assert.deepEqual(measureContextPressure(1_000_000, { maxContextTokens: null }), {
        state: 'disabled',
        maxContextTokens: null,
        availableInputTokens: null,
        softLimitTokens: null,
    })
})
