import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { ContextManager } from '../src/core/context-manager.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

test('default visibility keeps all registered tools model-visible', async () => {
    const harness = await createHarness()
    registerTool(harness.tools, 'tool-a')
    registerTool(harness.tools, 'tool-b')
    const requests = []
    harness.llm.register(
        'mock',
        {
            models: ['catalog-default'],
            async chat(request) {
                requests.push(request)
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'catalog-default' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/catalog-default',
        loop: new AgentLoopRuntime({
            sessions: harness.sessions,
            systemPrompt: harness.systemPrompt,
            tools: harness.tools,
            llm: harness.llm,
        }),
    })

    assert.equal(await agent.send('hello'), 'done')
    assert.deepEqual(schemaNames(requests[0].tools), ['tool-a', 'tool-b'])
    assert.deepEqual(requests[0].tools, harness.tools.schemas())
})

test('visibility is selected per step from fresh snapshots and does not restrict execution', async () => {
    const harness = await createHarness()
    let hiddenExecutions = 0
    registerTool(harness.tools, 'tool-b', {
        execute: async () => {
            hiddenExecutions += 1
            return 'hidden result'
        },
    })
    registerTool(harness.tools, 'tool-a', {
        execute: async () => {
            assert.ok(harness.tools.get('tool-b'))
            const hidden = await harness.tools.execute('tool-b', {})
            assert.equal(hidden.isError, false)
            harness.tools.register({
                name: 'tool-c',
                description: 'registered after step one',
                parameters: { type: 'object', properties: {} },
                execute: async () => 'c',
            })
            return 'a complete'
        },
    })

    const tokenRequests = []
    const contextManager = new ContextManager({
        sessions: harness.sessions,
        tokenMeter: {
            estimateRequest(request) {
                tokenRequests.push(request)
                return { tokens: 1, exact: false, method: 'test-meter' }
            },
        },
    })
    const visibilityRequests = []
    const toolVisibility = {
        select(request) {
            visibilityRequests.push(request)
            return request.step === 1 ? ['tool-a'] : ['tool-c']
        },
    }
    const llmRequests = []
    harness.llm.register(
        'mock',
        {
            models: ['catalog-subset'],
            async chat(request) {
                llmRequests.push(request)
                if (llmRequests.length === 1) {
                    return {
                        toolCalls: [{ id: 'call-a', name: 'tool-a', arguments: {} }],
                    }
                }
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'catalog-subset' },
    )
    const loop = new AgentLoopRuntime({
        sessions: harness.sessions,
        systemPrompt: harness.systemPrompt,
        tools: harness.tools,
        llm: harness.llm,
        contextManager,
        toolVisibility,
    })
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/catalog-subset',
        loop,
    })

    assert.equal(await agent.send('find something'), 'done')
    assert.equal(visibilityRequests.length, 2)
    assert.deepEqual(
        visibilityRequests.map((request) => request.step),
        [1, 2],
    )
    assert.deepEqual(
        visibilityRequests.map((request) => request.input),
        ['find something', 'find something'],
    )
    assert.deepEqual(
        visibilityRequests[0].catalog.map((entry) => entry.name),
        ['tool-b', 'tool-a'],
    )
    assert.deepEqual(
        visibilityRequests[1].catalog.map((entry) => entry.name),
        ['tool-b', 'tool-a', 'tool-c'],
    )
    assert.deepEqual(
        llmRequests.map((request) => schemaNames(request.tools)),
        [['tool-a'], ['tool-c']],
    )
    assert.equal(harness.tools.get('tool-b') !== undefined, true)
    assert.equal(hiddenExecutions, 1)
    assert.equal(tokenRequests.length, 2)
    for (const [index, measured] of tokenRequests.entries()) {
        assert.strictEqual(measured.tools, llmRequests[index].tools)
        assert.deepEqual(measured.tools, llmRequests[index].tools)
    }
})

async function createHarness() {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    return { sessions, systemPrompt, tools, llm, agents, session }
}

function registerTool(tools, name, overrides = {}) {
    return tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: async () => name,
        ...overrides,
    })
}

function schemaNames(schemas) {
    return schemas.map((schema) => schema.function.name)
}
