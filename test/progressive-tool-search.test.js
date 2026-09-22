import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { ContextManager } from '../src/core/context-manager.js'
import { DeterministicToolVisibility } from '../src/core/deterministic-tool-visibility.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { ProgressiveToolVisibility } from '../src/core/progressive-tool-visibility.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolActivationStore } from '../src/core/tool-activation-store.js'
import { ToolCatalog } from '../src/core/tool-catalog.js'
import { rankTools } from '../src/core/tool-ranking.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import * as toolsPlugin from '../src/plugins/tools.js'
import * as toolSearchPlugin from '../src/tools/tool-search.js'

test('ToolActivationStore deduplicates activations and isolates concurrent Runs', async () => {
    const store = new ToolActivationStore({ maxActivatedTools: 2 })
    assert.deepEqual(store.activate('run-a', ['alpha', 'alpha']), {
        activated: ['alpha'],
        alreadyActivated: [],
        limitReached: [],
    })
    assert.deepEqual(store.activate('run-a', ['alpha', 'beta', 'gamma']), {
        activated: ['beta'],
        alreadyActivated: ['alpha'],
        limitReached: ['gamma'],
    })

    await Promise.all([
        Promise.resolve().then(() => store.activate('run-a', ['delta'])),
        Promise.resolve().then(() => store.activate('run-b', ['gamma'])),
    ])
    assert.deepEqual(store.names('run-a'), ['alpha', 'beta'])
    assert.deepEqual(store.names('run-b'), ['gamma'])
    assert.throws(() => new ToolActivationStore({ maxActivatedTools: 0 }), /positive integer/)
})

test('tool_search returns compact lexical hits and activates only the current Run', async () => {
    const harness = await createSearchHarness()
    try {
        register(harness.tools, 'weather_lookup', {
            description: `Retrieve weather forecasts by city ${'details '.repeat(30)}`,
        })
        register(harness.tools, 'unrelated', { description: 'Manage unrelated records' })
        const catalog = new ToolCatalog({ tools: harness.tools })
        const activationStore = new ToolActivationStore({ maxActivatedTools: 2 })
        await harness.root.plugin(toolSearchPlugin, { toolCatalog: catalog, activationStore })

        const fullCatalog = catalog.snapshot().list()
        const expectedMatches = rankTools(
            fullCatalog.filter((tool) => tool.name !== 'tool_search'),
            'weather forecast',
        ).map(({ name }) => name)
        const result = await harness.tools.execute(
            'tool_search',
            { query: 'weather forecast' },
            { runId: 'run-a' },
        )
        assert.equal(result.isError, false)
        assert.deepEqual(
            result.value.matches.map(({ name }) => name),
            expectedMatches,
        )
        assert.equal(result.value.matches.length, 1)
        assert.equal(result.value.matches[0].name, 'weather_lookup')
        assert.equal(result.value.matches[0].description.length, 160)
        assert.equal(result.value.matches[0].description.endsWith('...'), true)
        assert.deepEqual(result.value.activated, ['weather_lookup'])
        assert.equal('parameters' in result.value.matches[0], false)
        assert.deepEqual(activationStore.names('run-a'), ['weather_lookup'])
        assert.deepEqual(activationStore.names('run-b'), [])

        const noMatch = await harness.tools.execute(
            'tool_search',
            { query: 'zzzxxyy' },
            { runId: 'run-a' },
        )
        assert.deepEqual(noMatch.value.matches, [])
        const excludesSelf = await harness.tools.execute(
            'tool_search',
            { query: 'tool_search' },
            { runId: 'run-a' },
        )
        assert.deepEqual(excludesSelf.value.matches, [])
    } finally {
        await harness.root.fiber.dispose()
    }
})

test('concurrent tool_search Runs activate different Tools without cross-Run leakage', async () => {
    const harness = await createSearchHarness()
    try {
        register(harness.tools, 'weather_lookup', { description: 'find weather forecast' })
        register(harness.tools, 'calendar_lookup', { description: 'find calendar event' })
        const activationStore = new ToolActivationStore()
        await harness.root.plugin(toolSearchPlugin, {
            toolCatalog: new ToolCatalog({ tools: harness.tools }),
            activationStore,
        })

        await Promise.all([
            harness.tools.execute(
                'tool_search',
                { query: 'weather forecast' },
                { runId: 'run-weather' },
            ),
            harness.tools.execute(
                'tool_search',
                { query: 'calendar event' },
                { runId: 'run-calendar' },
            ),
        ])
        const visibility = new ProgressiveToolVisibility({
            baseVisibility: { select: () => [] },
            activationStore,
        })
        assert.deepEqual(activationStore.names('run-weather'), ['weather_lookup'])
        assert.deepEqual(activationStore.names('run-calendar'), ['calendar_lookup'])
        assert.deepEqual(
            await visibility.select({
                runId: 'run-weather',
                catalog: harness.tools.list(),
            }),
            ['tool_search', 'weather_lookup'],
        )
        assert.deepEqual(
            await visibility.select({
                runId: 'run-calendar',
                catalog: harness.tools.list(),
            }),
            ['tool_search', 'calendar_lookup'],
        )
    } finally {
        await harness.root.fiber.dispose()
    }
})

test('tool_search reports activation limit and repeated searches do not consume extra slots', async () => {
    const harness = await createSearchHarness()
    try {
        for (const name of ['weather_city', 'weather_alert', 'weather_history']) {
            register(harness.tools, name, { description: 'weather forecast lookup' })
        }
        const activationStore = new ToolActivationStore({ maxActivatedTools: 2 })
        await harness.root.plugin(toolSearchPlugin, {
            toolCatalog: new ToolCatalog({ tools: harness.tools }),
            activationStore,
        })

        const first = await harness.tools.execute(
            'tool_search',
            { query: 'weather forecast', limit: 3 },
            { runId: 'run-a' },
        )
        assert.deepEqual(first.value.activated, ['weather_city', 'weather_alert'])
        assert.deepEqual(first.value.notActivatedDueToLimit, ['weather_history'])
        assert.equal(first.value.message, 'activation limit reached')

        const repeated = await harness.tools.execute(
            'tool_search',
            { query: 'weather forecast', limit: 3 },
            { runId: 'run-a' },
        )
        assert.deepEqual(repeated.value.activated, [])
        assert.deepEqual(repeated.value.alreadyActivated, ['weather_city', 'weather_alert'])
        assert.deepEqual(repeated.value.notActivatedDueToLimit, ['weather_history'])
        assert.deepEqual(activationStore.names('run-a'), ['weather_city', 'weather_alert'])
    } finally {
        await harness.root.fiber.dispose()
    }
})

test('ProgressiveToolVisibility pins search, ignores stale activations, and unions Run hits', async () => {
    const store = new ToolActivationStore()
    store.activate('run-a', ['registered', 'removed'])
    const visibility = new ProgressiveToolVisibility({
        baseVisibility: { select: () => ['base'] },
        activationStore: store,
    })
    const selected = await visibility.select({
        runId: 'run-a',
        catalog: [{ name: 'base' }, { name: 'registered' }, { name: 'tool_search' }],
    })
    assert.deepEqual(selected, ['base', 'tool_search', 'registered'])
    assert.deepEqual(
        await visibility.select({ runId: 'run-b', catalog: [{ name: 'tool_search' }] }),
        ['tool_search'],
    )
})

test('progressive integration discovers, exposes, executes, and clears Tools per Run', async () => {
    const root = new Context()
    await root.plugin(toolsPlugin)
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    let targetExecutions = 0
    register(root.tools, 'task_helper', { description: 'Handle a task request' })
    register(root.tools, 'weather_lookup', {
        description: 'Retrieve weather forecasts by city',
        execute: async () => {
            targetExecutions += 1
            return 'sunny'
        },
    })
    for (let index = 0; index < 10; index += 1) {
        register(root.tools, `irrelevant_${index}`, { description: 'unrelated catalog entry' })
    }

    const activationStore = new ToolActivationStore({ maxActivatedTools: 4 })
    const toolCatalog = new ToolCatalog({ tools: root.tools })
    await root.plugin(toolSearchPlugin, { toolCatalog, activationStore })
    const baseVisibility = new DeterministicToolVisibility({ maxVisibleTools: 1 })
    const toolVisibility = new ProgressiveToolVisibility({ baseVisibility, activationStore })
    const visibilityRequests = []
    const measuredRequests = []
    const contextManager = new ContextManager({
        sessions,
        tokenMeter: {
            estimateRequest(request) {
                measuredRequests.push(request)
                return { tokens: 10, exact: false, method: 'test-meter' }
            },
        },
    })
    const modelRequests = []
    llm.register(
        'mock',
        {
            models: ['progressive'],
            async chat(request) {
                modelRequests.push(request)
                if (modelRequests.length === 1) {
                    return {
                        toolCalls: [
                            {
                                id: 'search-call',
                                name: 'tool_search',
                                arguments: { query: 'weather forecast' },
                            },
                        ],
                    }
                }
                if (modelRequests.length === 2) {
                    return {
                        toolCalls: [
                            {
                                id: 'weather-call',
                                name: 'weather_lookup',
                                arguments: { city: 'Shanghai' },
                            },
                        ],
                    }
                }
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'progressive' },
    )
    const recordingVisibility = {
        async select(request) {
            visibilityRequests.push(request)
            return toolVisibility.select(request)
        },
        beginRun: (args) => toolVisibility.beginRun(args),
        endRun: (args) => toolVisibility.endRun(args),
    }
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools: root.tools,
        llm,
        contextManager,
        toolCatalog,
        toolVisibility: recordingVisibility,
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/progressive',
        loop,
    })

    try {
        assert.equal(await agent.send('task request'), 'done')
        assert.equal(targetExecutions, 1)
        assert.deepEqual(schemaNames(modelRequests[0].tools), ['task_helper', 'tool_search'])
        assert.deepEqual(schemaNames(modelRequests[1].tools), [
            'task_helper',
            'weather_lookup',
            'tool_search',
        ])
        for (const [index, request] of modelRequests.entries()) {
            assert.strictEqual(measuredRequests[index].tools, request.tools)
        }
        const runId = visibilityRequests[0].runId
        assert.ok(runId)
        assert.equal(visibilityRequests[1].runId, runId)
        assert.deepEqual(activationStore.names(runId), [])

        assert.equal(await agent.send('task request'), 'done')
        assert.deepEqual(schemaNames(modelRequests[3].tools), ['task_helper', 'tool_search'])
        assert.notEqual(visibilityRequests[3].runId, runId)
        assert.deepEqual(activationStore.names(visibilityRequests[3].runId), [])
    } finally {
        await root.fiber.dispose()
    }
})

test('visibility cleanup failure cannot change the Agent Run outcome', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    llm.register(
        'mock',
        {
            models: ['visibility-cleanup'],
            async chat() {
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'visibility-cleanup' },
    )
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/visibility-cleanup',
        loop: new AgentLoopRuntime({
            sessions,
            systemPrompt,
            tools,
            llm,
            toolVisibility: {
                select: () => [],
                endRun() {
                    throw new Error('cleanup failed')
                },
            },
        }),
    })
    assert.equal(await agent.send('hello'), 'done')
})

async function createSearchHarness() {
    const root = new Context()
    await root.plugin(toolsPlugin)
    return { root, tools: root.tools }
}

function register(tools, name, overrides = {}) {
    return tools.register({
        name,
        description: `${name} description`,
        parameters: { type: 'object', properties: {} },
        execute: async () => name,
        ...overrides,
    })
}

function schemaNames(schemas) {
    return schemas.map((schema) => schema.function.name)
}
