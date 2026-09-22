import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { ContextManager } from '../src/core/context-manager.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SemanticProgressDetector } from '../src/core/semantic-progress-detector.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import { CapturingTraceRuntime } from '../src/eval/eval-runner.js'

test('progress mode off preserves the existing AgentLoop behavior', async () => {
    const harness = await createHarness()
    registerEmptyTool(harness.tools)
    let requests = 0
    harness.llm.register(
        'mock',
        {
            models: ['off'],
            async chat(request) {
                harness.llmRequests.push(request)
                requests += 1
                return requests === 1
                    ? { toolCalls: [call('empty-1', 'empty')] }
                    : { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'off' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/off',
        loop: harness.loop,
    })

    assert.equal(await agent.send('run'), 'done')
    assert.equal(
        harness.llmRequests.some(({ system }) => system.includes('[Harness progress notice]')),
        false,
    )
    assert.equal(harness.trace.latest().stopReason, 'completed')
})

test('soft reminder is ephemeral and identical in context metering and the model request', async () => {
    const harness = await createHarness({
        progressDetectorFactory: () =>
            new SemanticProgressDetector({ softThreshold: 1, hardThreshold: null }),
    })
    registerEmptyTool(harness.tools)
    harness.tools.register({
        name: 'target',
        parameters: { type: 'object' },
        async execute() {
            return 'target result'
        },
    })
    let recovering = false
    harness.llm.register(
        'mock',
        {
            models: ['remind'],
            async chat(request) {
                harness.llmRequests.push(request)
                if (request.system.includes('[Harness progress notice]')) {
                    recovering = true
                    return { toolCalls: [call('target-1', 'target')] }
                }
                if (recovering) return { content: 'recovered', toolCalls: [] }
                return { toolCalls: [call(`empty-${harness.llmRequests.length}`, 'empty')] }
            },
        },
        { defaultModel: 'remind' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/remind',
        loop: harness.loop,
    })

    await agent.send('find target')
    const reminderRequest = harness.llmRequests.find(({ system }) =>
        system.includes('[Harness progress notice]'),
    )
    assert.ok(reminderRequest)
    assert.equal(
        harness.measuredRequests[harness.llmRequests.indexOf(reminderRequest)].system,
        reminderRequest.system,
    )
    assert.equal(harness.trace.latest().stopReason, 'completed')
    assert.equal(
        harness.sessions
            .get(harness.session.id)
            .events.some((event) => event.type.startsWith('progress/')),
        false,
    )
})

test('guarded mode hard-stops after durable Tool Results and preserves the call/result protocol', async () => {
    const harness = await createHarness({
        policy: { maxSteps: 10 },
        progressDetectorFactory: () =>
            new SemanticProgressDetector({ softThreshold: 2, hardThreshold: 4 }),
    })
    registerEmptyTool(harness.tools)
    harness.llm.register(
        'mock',
        {
            models: ['guarded'],
            async chat(request) {
                harness.llmRequests.push(request)
                return { toolCalls: [call(`empty-${harness.llmRequests.length}`, 'empty')] }
            },
        },
        { defaultModel: 'guarded' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/guarded',
        loop: harness.loop,
    })

    await agent.send('loop')
    const events = harness.sessions.get(harness.session.id).events
    const calls = events.flatMap((event) =>
        event.type === 'assistant/tool_calls' ? event.data.toolCalls : [],
    )
    const results = events.filter((event) => event.type === 'tool/result')
    assert.equal(harness.trace.latest().stopReason, 'no_progress')
    assert.equal(harness.trace.latest().steps.length, 5)
    assert.equal(calls.length, results.length)
    assert.deepEqual(
        new Set(results.map((event) => event.data.toolCallId)),
        new Set(calls.map((toolCall) => toolCall.id)),
    )
})

test('guarded mode stops an unrecoverable stall before baseline and both preserve Tool results', async () => {
    const runStall = async (guarded) => {
        const harness = await createHarness({
            policy: { maxSteps: 7 },
            progressDetectorFactory: guarded
                ? () => new SemanticProgressDetector({ softThreshold: 1, hardThreshold: 2 })
                : undefined,
        })
        registerEmptyTool(harness.tools)
        harness.llm.register(
            'mock',
            {
                models: [guarded ? 'guarded-stall' : 'baseline-stall'],
                async chat(request) {
                    harness.llmRequests.push(request)
                    return { toolCalls: [call(`empty-${harness.llmRequests.length}`, 'empty')] }
                },
            },
            { defaultModel: guarded ? 'guarded-stall' : 'baseline-stall' },
        )
        const model = guarded ? 'mock/guarded-stall' : 'mock/baseline-stall'
        const agent = harness.agents.create({
            sessionId: harness.session.id,
            model,
            loop: harness.loop,
        })
        await agent.send('cannot recover')
        const events = harness.sessions.get(harness.session.id).events
        const calls = events.flatMap((event) =>
            event.type === 'assistant/tool_calls' ? event.data.toolCalls : [],
        )
        const results = events.filter((event) => event.type === 'tool/result')
        assert.equal(calls.length, results.length)
        return harness.trace.latest()
    }

    const baseline = await runStall(false)
    const guarded = await runStall(true)
    assert.equal(baseline.stopReason, 'step_limit')
    assert.equal(guarded.stopReason, 'no_progress')
    assert.ok(guarded.steps.length < baseline.steps.length)
})

test('detector and reminder errors fail open', async () => {
    const harness = await createHarness({
        progressDetectorFactory: () => ({
            takeReminder() {
                throw new Error('reminder failure')
            },
            observeStep() {
                throw new Error('detector failure')
            },
        }),
    })
    registerEmptyTool(harness.tools)
    harness.llm.register(
        'mock',
        {
            models: ['throws'],
            async chat(request) {
                harness.llmRequests.push(request)
                return harness.llmRequests.length === 1
                    ? { toolCalls: [call('empty-1', 'empty')] }
                    : { content: 'completed', toolCalls: [] }
            },
        },
        { defaultModel: 'throws' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/throws',
        loop: harness.loop,
    })

    assert.equal(await agent.send('continue'), 'completed')
    assert.equal(harness.trace.latest().stopReason, 'completed')
})

test('each Agent Run creates fresh detector state', async () => {
    const detectors = []
    const harness = await createHarness({
        policy: { maxSteps: 10 },
        progressDetectorFactory: () => {
            const detector = new SemanticProgressDetector({ softThreshold: 1, hardThreshold: 2 })
            detectors.push(detector)
            return detector
        },
    })
    registerEmptyTool(harness.tools)
    harness.tools.register({
        name: 'target',
        parameters: { type: 'object' },
        async execute() {
            return 'done'
        },
    })
    harness.llm.register(
        'mock',
        {
            models: ['fresh'],
            async chat(request) {
                harness.llmRequests.push(request)
                if (harness.llmRequests.length === 5) {
                    return { toolCalls: [call('target-1', 'target')] }
                }
                if (harness.llmRequests.length === 6) return { content: 'done', toolCalls: [] }
                return { toolCalls: [call(`empty-${harness.llmRequests.length}`, 'empty')] }
            },
        },
        { defaultModel: 'fresh' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/fresh',
        loop: harness.loop,
    })

    await agent.send('first run')
    assert.equal(harness.trace.latest().stopReason, 'no_progress')
    assert.equal(await agent.send('second run'), 'done')
    assert.equal(detectors.length, 2)
    assert.equal(harness.trace.latest().stopReason, 'completed')
})

function createHarness({ policy, progressDetectorFactory } = {}) {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    systemPrompt.section({ name: 'base', text: 'Base system instructions.' })
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const llmRequests = []
    const measuredRequests = []
    const tokenMeter = {
        estimateRequest(request) {
            measuredRequests.push(request)
            return { tokens: 0, exact: false, method: 'test' }
        },
    }
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm,
        trace: new CapturingTraceRuntime(),
        policy,
        progressDetectorFactory,
        contextManager: new ContextManager({ sessions, tokenMeter }),
    })
    return sessions.create().then((session) => ({
        sessions,
        systemPrompt,
        tools,
        llm,
        agents,
        loop,
        session,
        llmRequests,
        measuredRequests,
        trace: loop.trace,
    }))
}

function registerEmptyTool(tools) {
    tools.register({
        name: 'empty',
        parameters: { type: 'object' },
        async execute() {
            return ''
        },
    })
}

function call(id, name) {
    return { id, name, arguments: {} }
}
