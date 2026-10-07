import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { ContextManager } from '../src/core/context-manager.js'
import { COMPACTION_SUMMARY_PREAMBLE } from '../src/core/context-projector.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
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

test('DeepSeek replay diagnostics contain structure but no message or reasoning text', () => {
    const metadata = deepseek.deepSeekMessageMetadata([
        { role: 'user', content: 'PRIVATE_PROMPT_SENTINEL' },
        {
            role: 'assistant',
            content: 'PRIVATE_CONTENT_SENTINEL',
            reasoning_content: 'PRIVATE_REASONING_SENTINEL',
            tool_calls: [{ id: 'call-1' }],
        },
    ])

    assert.deepEqual(metadata, [
        {
            index: 0,
            role: 'user',
            hasReasoningContent: false,
            hasToolCalls: false,
            toolCallCount: 0,
        },
        {
            index: 1,
            role: 'assistant',
            hasReasoningContent: true,
            hasToolCalls: true,
            toolCallCount: 1,
        },
    ])
    assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_(PROMPT|CONTENT|REASONING)_SENTINEL/)
})

test('DeepSeek replays exact reasoning for repeated Tool Call turns', async () => {
    const harness = await createHarness([
        response({
            reasoningContent: 'inspect first',
            toolCalls: [{ id: 'call-a', name: 'read_file', arguments: { path: 'a.js' } }],
        }),
        response({
            reasoningContent: 'inspect second',
            toolCalls: [{ id: 'call-b', name: 'read_file', arguments: { path: 'b.js' } }],
        }),
        response({ reasoningContent: 'finish', content: 'done' }),
    ])
    try {
        assert.equal(await harness.agent.send('read both files'), 'done')
        assert.equal(harness.requests.length, 3)
        assert.deepEqual(
            harness.requests[2].body.messages
                .filter((message) => message.tool_calls)
                .map((message) => message.reasoning_content),
            ['inspect first', 'inspect second'],
        )
    } finally {
        await harness.dispose()
    }
})

test('DeepSeek preserves an explicitly empty reasoning_content field', async () => {
    const harness = await createHarness([
        response({
            reasoningContent: '',
            toolCalls: [{ id: 'call-a', name: 'read_file', arguments: { path: 'a.js' } }],
        }),
        response({ content: 'done' }),
    ])
    try {
        await harness.agent.send('read a file')
        const assistant = harness.requests[1].body.messages.find((message) => message.tool_calls)
        assert.ok(Object.hasOwn(assistant, 'reasoning_content'))
        assert.equal(assistant.reasoning_content, '')
    } finally {
        await harness.dispose()
    }
})

test('DeepSeek normalizes null and absent reasoning fields at the request boundary', async () => {
    for (const reasoningContent of [null, undefined]) {
        const harness = await createHarness([
            response({
                ...(reasoningContent === undefined ? {} : { reasoningContent }),
                toolCalls: [{ id: 'call-a', name: 'read_file', arguments: { path: 'a.js' } }],
            }),
            response({ content: 'done' }),
        ])
        try {
            await harness.agent.send('read a file')
            const assistant = harness.requests[1].body.messages.find(
                (message) => message.tool_calls,
            )
            assert.ok(Object.hasOwn(assistant, 'reasoning_content'))
            assert.equal(assistant.reasoning_content, '')
            const event = harness.session.events.find(
                (item) => item.type === 'assistant/tool_calls',
            )
            assert.equal(
                Object.hasOwn(event.data, 'reasoningContent'),
                reasoningContent !== undefined,
            )
        } finally {
            await harness.dispose()
        }
    }
})

test('DeepSeek replays reasoning from assistant messages on the next Agent.send', async () => {
    const harness = await createHarness([
        response({ reasoningContent: 'first completed turn', content: 'first answer' }),
        response({ content: 'second answer' }),
    ])
    try {
        assert.equal(await harness.agent.send('first question'), 'first answer')
        assert.equal(await harness.agent.send('second question'), 'second answer')
        const assistant = harness.requests[1].body.messages.find(
            (message) => message.content === 'first answer',
        )
        assert.equal(assistant.reasoning_content, 'first completed turn')
        assert.equal(
            harness.session.events.find((event) => event.type === 'assistant/message').data
                .reasoningContent,
            'first completed turn',
        )
    } finally {
        await harness.dispose()
    }
})

test('DeepSeek normalizes a real ContextManager compaction summary for tool requests', async () => {
    const tokenMeter = {
        estimateRequest({ messages = [] } = {}) {
            return {
                tokens: messages[0]?.content?.startsWith(COMPACTION_SUMMARY_PREAMBLE) ? 20 : 100,
                exact: false,
                method: 'compaction-replay-test',
            }
        },
    }
    const harness = await createHarness([response({ content: 'continued' })], {
        contextManager: new ContextManager({
            sessions: new SessionRuntime(),
            tokenMeter,
            policy: { maxContextTokens: 101, compactAtRatio: 0.8 },
        }),
        seedReasoningHistory: true,
    })
    try {
        await harness.agent.send('continue after compaction')
        const summary = harness.requests[0].body.messages.find((message) =>
            message.content?.startsWith(COMPACTION_SUMMARY_PREAMBLE),
        )
        assert.ok(summary)
        assert.equal(summary.role, 'assistant')
        assert.ok(Object.hasOwn(summary, 'reasoning_content'))
        assert.equal(summary.reasoning_content, '')
        assert.ok(harness.session.events.some((event) => event.type === 'context/compaction'))
    } finally {
        await harness.dispose()
    }
})

test('thinking disabled does not add provider-generated reasoning fields', async () => {
    const harness = await createHarness([response({ content: 'done' })], {
        thinking: 'disabled',
    })
    try {
        await harness.agent.send('question')
        assert.equal(
            harness.requests[0].body.messages.some((message) =>
                Object.hasOwn(message, 'reasoning_content'),
            ),
            false,
        )
    } finally {
        await harness.dispose()
    }
})

function response({ reasoningContent, content, toolCalls = [] }) {
    const lines = []
    if (reasoningContent !== undefined) {
        lines.push(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningContent } }] })}`,
        )
    }
    if (content !== undefined) {
        lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`)
    }
    if (toolCalls.length) {
        lines.push(
            `data: ${JSON.stringify({
                choices: [
                    {
                        delta: {
                            tool_calls: toolCalls.map((call, index) => ({
                                index,
                                id: call.id,
                                type: 'function',
                                function: {
                                    name: call.name,
                                    arguments: JSON.stringify(call.arguments),
                                },
                            })),
                        },
                    },
                ],
            })}`,
        )
    }
    lines.push('data: [DONE]')
    return lines
}

async function createHarness(
    responses,
    { thinking = 'enabled', contextManager, seedReasoningHistory = false } = {},
) {
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) })
        const lines = responses.shift()
        if (!lines) throw new Error('unexpected DeepSeek request')
        return sseResponse(lines)
    }

    const root = new Context()
    const sessions = contextManager?.sessions ?? new SessionRuntime()
    const session = await sessions.create()
    if (seedReasoningHistory) {
        await sessions.append(session.id, 'user/message', { content: 'old goal' })
        await sessions.append(session.id, 'assistant/tool_calls', {
            reasoningContent: 'historical reasoning sentinel',
            toolCalls: [{ id: 'old-call', name: 'read_file', arguments: { path: 'old.js' } }],
        })
        await sessions.append(session.id, 'tool/result', {
            toolCallId: 'old-call',
            name: 'read_file',
            content: 'old result',
        })
        await sessions.append(session.id, 'assistant/message', {
            content: 'old answer',
            reasoningContent: 'historical assistant reasoning',
        })
    }
    await root.plugin(llm)
    await root.plugin(deepseek, {
        apiKey: 'test-key',
        baseUrl: 'https://example.test',
        models: ['test-model'],
        thinking,
    })
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    tools.register({
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async ({ path }) => `read ${path}`,
    })
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm: root.llm,
        ...(contextManager ? { contextManager } : {}),
    })
    const agent = new AgentRuntime().create({
        sessionId: session.id,
        model: 'deepseek/test-model',
        loop,
    })

    return {
        agent,
        requests,
        session,
        async dispose() {
            globalThis.fetch = originalFetch
            await sessions.dispose()
            await root.fiber.dispose()
        },
    }
}
