import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as deepseek from '../src/models/deepseek.js'
import * as llm from '../src/plugins/llm.js'

function sseResponse(lines) {
    const encoder = new TextEncoder()
    let read = false
    return {
        ok: true,
        body: {
            getReader() {
                return {
                    async read() {
                        if (read) return { done: true, value: undefined }
                        read = true
                        return { done: false, value: encoder.encode(`${lines.join('\n')}\n`) }
                    },
                    releaseLock() {},
                }
            },
        },
    }
}

test('DeepSeek adapter converts final streaming usage into the unified format', async () => {
    const originalFetch = globalThis.fetch
    let request
    globalThis.fetch = async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) }
        return sseResponse([
            'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
            'data: {"choices":[{"delta":{"content":"done"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":12,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":10,"completion_tokens_details":{"reasoning_tokens":5}}}',
            'data: [DONE]',
        ])
    }

    const root = new Context()
    try {
        await root.plugin(llm)
        await root.plugin(deepseek, {
            apiKey: 'test-key',
            baseUrl: 'https://example.test',
            models: ['test-model'],
            thinking: 'enabled',
        })

        const result = await root.llm.chat(
            { system: 'system', messages: [], tools: [] },
            'deepseek/test-model',
        )

        assert.equal(request.url, 'https://example.test/chat/completions')
        assert.equal(request.body.stream_options.include_usage, true)
        assert.deepEqual(result.usage, {
            inputTokens: 40,
            outputTokens: 12,
            reasoningTokens: 5,
            cacheHitTokens: 30,
            cacheMissTokens: 10,
            cost: null,
        })
    } finally {
        globalThis.fetch = originalFetch
        await root.fiber.dispose()
    }
})

test('DeepSeek usage normalization preserves unavailable fields as null', () => {
    assert.deepEqual(deepseek.normalizeUsage({ prompt_tokens: 4, completion_tokens: 2 }), {
        inputTokens: 4,
        outputTokens: 2,
        reasoningTokens: null,
        cacheHitTokens: null,
        cacheMissTokens: null,
        cost: null,
    })
})
