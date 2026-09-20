import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { ContextManager } from '../src/core/context-manager.js'
import { JsonlSessionStore } from '../src/core/jsonl-session-store.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

test('ContextManager matches the legacy projection and preserves Tool protocol without mutation', async () => {
    const sessions = new SessionRuntime()
    const session = await sessions.create()
    await sessions.append(session.id, 'user/message', { content: 'question' })
    await sessions.append(session.id, 'assistant/tool_calls', {
        content: null,
        reasoningContent: 'inspect first',
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'README.md' } }],
    })
    await sessions.append(session.id, 'tool/result', {
        toolCallId: 'call-1',
        name: 'read',
        content: 'contents',
    })
    await sessions.append(session.id, 'assistant/message', { content: 'answer' })
    const before = JSON.stringify(session.events)

    const projection = new ContextManager({ sessions }).project(session.id)

    assert.deepEqual(projection.messages, sessions.deriveMessages(session.id))
    assert.equal(projection.metadata.sourceEventCount, 5)
    assert.equal(projection.metadata.projectedMessageCount, 4)
    assert.equal(projection.metadata.compacted, false)
    assert.equal(projection.metadata.tokenEstimate.exact, false)
    assert.equal(projection.metadata.tokenEstimate.method, 'heuristic-v1')
    assert.ok(projection.metadata.tokenEstimate.tokens > 0)
    assert.deepEqual(projection.metadata.pressure, {
        state: 'disabled',
        maxContextTokens: null,
        availableInputTokens: null,
        softLimitTokens: null,
    })
    assert.deepEqual(projection.messages[1], {
        role: 'assistant',
        content: null,
        reasoning_content: 'inspect first',
        tool_calls: [
            {
                id: 'call-1',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"README.md"}' },
            },
        ],
    })
    assert.deepEqual(projection.messages[2], {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'contents',
    })
    assert.equal(JSON.stringify(session.events), before)
})

test('ContextManager preserves reset semantics while counting the complete source Event Log', async () => {
    const sessions = new SessionRuntime()
    const session = await sessions.create()
    await sessions.append(session.id, 'user/message', { content: 'before reset' })
    await sessions.reset(session.id)
    await sessions.append(session.id, 'user/message', { content: 'after reset' })

    const projection = new ContextManager({ sessions }).project(session.id)

    assert.deepEqual(projection.messages, [{ role: 'user', content: 'after reset' }])
    assert.deepEqual(projection.messages, sessions.deriveMessages(session.id))
    assert.equal(projection.metadata.sourceEventCount, 4)
    assert.equal(projection.metadata.projectedMessageCount, 1)
    assert.equal(projection.metadata.compacted, false)
})

test('ContextManager projects a resumed durable Session from its complete history', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-context-resume-'))
    try {
        const first = new SessionRuntime({ store: new JsonlSessionStore({ directory }) })
        const session = await first.create()
        await first.append(session.id, 'user/message', { content: 'persisted question' })
        await first.append(session.id, 'assistant/message', { content: 'persisted answer' })
        await first.dispose()

        const resumed = new SessionRuntime({ store: new JsonlSessionStore({ directory }) })
        await resumed.open(session.id)
        const eventsBefore = JSON.stringify(resumed.get(session.id).events)
        const projection = new ContextManager({ sessions: resumed }).project(session.id)

        assert.deepEqual(projection.messages, [
            { role: 'user', content: 'persisted question' },
            { role: 'assistant', content: 'persisted answer' },
        ])
        assert.equal(projection.metadata.sourceEventCount, 3)
        assert.equal(JSON.stringify(resumed.get(session.id).events), eventsBefore)
        await resumed.dispose()
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('parallel Tool results remain model-ordered in ContextManager projection', async () => {
    const harness = await createHarness()
    const completed = []
    harness.tools.register({
        name: 'parallel-read',
        concurrencySafe: true,
        async execute({ id }) {
            await delay(id === 'A' ? 20 : 5)
            completed.push(id)
            return `result-${id}`
        },
    })
    let turn = 0
    harness.llm.register(
        'mock',
        {
            models: ['parallel-context'],
            async chat() {
                turn += 1
                return turn === 1
                    ? {
                          toolCalls: [
                              { id: 'call-A', name: 'parallel-read', arguments: { id: 'A' } },
                              { id: 'call-B', name: 'parallel-read', arguments: { id: 'B' } },
                          ],
                      }
                    : { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'parallel-context' },
    )

    assert.equal(await harness.agent('parallel-context').send('parallel'), 'done')
    assert.deepEqual(completed, ['B', 'A'])
    const projection = new ContextManager({ sessions: harness.sessions }).project(
        harness.session.id,
    )
    assert.deepEqual(
        projection.messages
            .filter((message) => message.role === 'tool')
            .map((message) => [message.tool_call_id, message.content]),
        [
            ['call-A', 'result-A'],
            ['call-B', 'result-B'],
        ],
    )
})

test('AgentLoop obtains model messages exclusively through the injected ContextManager', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    systemPrompt.section({ name: 'test', text: 'system context' })
    tools.register({
        name: 'visible-tool',
        description: 'visible schema',
        execute() {},
    })
    sessions.deriveMessages = () => {
        throw new Error('legacy projection must not be called')
    }
    let projected
    const contextManager = {
        prepare(sessionId, context) {
            projected = { sessionId, context }
            return {
                messages: [{ role: 'user', content: 'projected context' }],
                metadata: {
                    sourceEventCount: sessions.get(sessionId).events.length,
                    projectedMessageCount: 1,
                    pressure: { state: 'normal' },
                    compacted: false,
                },
            }
        },
    }
    llm.register(
        'mock',
        {
            models: ['context-boundary'],
            async chat({ messages, model, system, tools: requestTools }) {
                assert.deepEqual(messages, [{ role: 'user', content: 'projected context' }])
                assert.equal(model, 'context-boundary')
                assert.equal(system, 'system context')
                assert.equal(requestTools, projected.context.tools)
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'context-boundary' },
    )
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm,
        contextManager,
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/context-boundary',
        loop,
    })

    assert.equal(await agent.send('original input'), 'done')
    assert.equal(projected.sessionId, session.id)
    assert.equal(projected.context.agent, agent)
    assert.equal(projected.context.step, 1)
    assert.equal(projected.context.model, 'mock/context-boundary')
    assert.equal(projected.context.system, 'system context')
    assert.equal(projected.context.tools.length, 1)
    assert.match(projected.context.runId, /^[0-9a-f-]{36}$/)
    assert.match(projected.context.stepId, /^[0-9a-f-]{36}$/)
})

test('ContextManager reports token estimate and pressure without changing projection or events', async () => {
    const sessions = new SessionRuntime()
    const session = await sessions.create()
    await sessions.append(session.id, 'user/message', { content: 'unchanged' })
    const before = JSON.stringify(session.events)
    let request
    const tokenMeter = {
        estimateRequest(value) {
            request = value
            return { tokens: 70, exact: false, method: 'test-meter' }
        },
    }
    const manager = new ContextManager({
        sessions,
        tokenMeter,
        policy: {
            maxContextTokens: 100,
            reservedOutputTokens: 20,
            compactAtRatio: 0.75,
        },
    })
    const tools = [{ type: 'function', function: { name: 'read' } }]
    const projection = manager.project(session.id, {
        model: 'mock/model',
        system: 'system',
        tools,
    })

    assert.deepEqual(projection.messages, [{ role: 'user', content: 'unchanged' }])
    assert.deepEqual(request, {
        model: 'mock/model',
        system: 'system',
        messages: projection.messages,
        tools,
    })
    assert.deepEqual(projection.metadata.tokenEstimate, {
        tokens: 70,
        exact: false,
        method: 'test-meter',
    })
    assert.deepEqual(projection.metadata.pressure, {
        state: 'soft_limit',
        maxContextTokens: 100,
        availableInputTokens: 80,
        softLimitTokens: 60,
    })
    assert.equal(projection.metadata.compacted, false)
    assert.equal(JSON.stringify(session.events), before)
})

async function createHarness() {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm })
    const session = await sessions.create()
    return {
        sessions,
        tools,
        llm,
        session,
        agent(model) {
            return agents.create({ sessionId: session.id, model: `mock/${model}`, loop })
        },
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
