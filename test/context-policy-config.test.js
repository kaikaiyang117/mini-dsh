import assert from 'node:assert/strict'
import test from 'node:test'
import { contextPolicyFromEnv } from '../src/core/context-policy-config.js'
import { runPolicyFromEnv } from '../src/core/run-policy-config.js'

test('contextPolicyFromEnv disables pressure when the context window is absent, empty, or null', () => {
    const disabled = {
        maxContextTokens: null,
        reservedOutputTokens: 0,
        compactAtRatio: 0.8,
    }

    assert.deepEqual(contextPolicyFromEnv({}), disabled)
    assert.deepEqual(contextPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: '' }), disabled)
    assert.deepEqual(contextPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: 'null' }), disabled)
})

test('contextPolicyFromEnv enables and validates an explicit policy', () => {
    assert.deepEqual(
        contextPolicyFromEnv({
            MINI_DSH_MAX_CONTEXT_TOKENS: '64000',
            MINI_DSH_RESERVED_OUTPUT_TOKENS: '8192',
            MINI_DSH_COMPACT_AT_RATIO: '0.75',
        }),
        {
            maxContextTokens: 64_000,
            reservedOutputTokens: 8192,
            compactAtRatio: 0.75,
        },
    )
})

test('contextPolicyFromEnv rejects invalid environment values', () => {
    assert.throws(
        () => contextPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: 'many' }),
        /positive integer/,
    )
    assert.throws(
        () =>
            contextPolicyFromEnv({
                MINI_DSH_MAX_CONTEXT_TOKENS: '64000',
                MINI_DSH_RESERVED_OUTPUT_TOKENS: 'none',
            }),
        /non-negative integer/,
    )
    assert.throws(
        () =>
            contextPolicyFromEnv({
                MINI_DSH_MAX_CONTEXT_TOKENS: '64000',
                MINI_DSH_COMPACT_AT_RATIO: '2',
            }),
        /at most 1/,
    )
})

test('production ContextPolicy reserves output tokens by default when enabled', () => {
    assert.deepEqual(contextPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: '64000' }), {
        maxContextTokens: 64_000,
        reservedOutputTokens: 4096,
        compactAtRatio: 0.8,
    })
    assert.throws(
        () => contextPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: '4096' }),
        /less than maxContextTokens/,
    )
})

test('RunPolicy and ContextPolicy environment settings remain independent', () => {
    const env = {
        MINI_DSH_MAX_INPUT_TOKENS: '123',
        MINI_DSH_MAX_CONTEXT_TOKENS: '64000',
    }
    const runPolicy = runPolicyFromEnv(env)
    const contextPolicy = contextPolicyFromEnv(env)

    assert.equal(runPolicy.maxInputTokens, 123)
    assert.equal(Object.hasOwn(runPolicy, 'maxContextTokens'), false)
    assert.equal(contextPolicy.maxContextTokens, 64_000)
    assert.equal(Object.hasOwn(contextPolicy, 'maxInputTokens'), false)
    assert.equal(contextPolicyFromEnv({ MINI_DSH_MAX_INPUT_TOKENS: '1' }).maxContextTokens, null)
    assert.equal(runPolicyFromEnv({ MINI_DSH_MAX_CONTEXT_TOKENS: '64000' }).maxInputTokens, null)
})
