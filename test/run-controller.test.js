import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { normalizeRunPolicy, RunController } from '../src/core/run-controller.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import { TraceRuntime } from '../src/core/trace-runtime.js'

test('RunController allows a normal run and keeps reasoning separate from output budget', () => {
    const controller = new RunController({
        policy: {
            maxSteps: null,
            maxToolCalls: null,
            maxInputTokens: null,
            maxOutputTokens: 10,
        },
    })

    assert.equal(controller.beforeStep().action, 'continue')
    const usage = controller.recordLlmUsage({
        inputTokens: 3,
        outputTokens: 10,
        reasoningTokens: 20,
    })
    assert.equal(usage.stopReason, 'output_token_limit')
    assert.equal(usage.state.outputTokens, 10)
    assert.equal(usage.state.reasoningTokens, 20)
})

test('RunController enforces step and tool-call limits with structured decisions', () => {
    const steps = new RunController({ policy: { maxSteps: 1 } })
    assert.equal(steps.beforeStep().action, 'continue')
    assert.deepEqual(steps.beforeStep(), {
        action: 'stop',
        stopReason: 'step_limit',
        state: steps.snapshot(),
    })

    const tools = new RunController({ policy: { maxToolCalls: 1 } })
    assert.equal(tools.beforeToolCall().action, 'continue')
    assert.equal(tools.beforeToolCall().stopReason, 'tool_call_limit')
})

test('RunController enforces token, duration, failure, and cost limits', () => {
    const input = new RunController({ policy: { maxInputTokens: 2 } })
    assert.equal(input.recordLlmUsage({ inputTokens: 2 }).stopReason, 'input_token_limit')

    const clock = { value: 0 }
    const duration = new RunController({
        policy: { maxDurationMs: 5 },
        now: () => clock.value,
    })
    assert.equal(duration.beforeStep().action, 'continue')
    clock.value = 5
    assert.equal(duration.beforeToolCall().stopReason, 'time_limit')

    const failures = new RunController({ policy: { maxToolFailures: 1 } })
    assert.equal(failures.recordToolResult({ isError: true }).stopReason, 'tool_failure_limit')

    const unknownCost = new RunController({ policy: { maxCost: 0 } })
    assert.equal(unknownCost.snapshot().cost, null)
    const unknown = unknownCost.recordLlmUsage({ inputTokens: 1 })
    assert.equal(unknown.action, 'continue')
    assert.equal(unknown.state.cost, null)

    const knownCost = new RunController({ policy: { maxCost: 0.1 } })
    assert.equal(knownCost.recordLlmUsage({ cost: 0.1 }).stopReason, 'cost_limit')
})

test('null means unlimited while zero is an immediate limit', () => {
    assert.deepEqual(normalizeRunPolicy({}), {
        maxSteps: null,
        maxToolCalls: null,
        maxDurationMs: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        maxCost: null,
        maxToolFailures: null,
    })
    assert.equal(
        new RunController({ policy: { maxSteps: 0 } }).beforeStep().stopReason,
        'step_limit',
    )
    assert.equal(new RunController({ policy: { maxSteps: null } }).beforeStep().action, 'continue')
})

test('external cancellation has priority over other decisions', () => {
    const abort = new AbortController()
    abort.abort()
    const controller = new RunController({ policy: { maxSteps: 0 } })
    assert.equal(controller.beforeStep(abort.signal).stopReason, 'cancelled')
    assert.equal(controller.beforeToolCall(abort.signal).stopReason, 'cancelled')
})

test('RunController maps final hard context pressure to context_overflow', () => {
    const controller = new RunController()

    assert.equal(controller.recordContextPressure({ state: 'normal' }).action, 'continue')
    assert.equal(
        controller.recordContextPressure({ state: 'hard_limit' }).stopReason,
        'context_overflow',
    )
})

async function createHarness({ policy, trace, now } = {}) {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm,
        trace,
        policy,
    })
    const session = await sessions.create()
    return { sessions, systemPrompt, tools, llm, agents, loop, session, now }
}

test('AgentLoop stops at tool-call budget and completes the Event Log protocol', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-run-budget-'))
    try {
        const trace = new TraceRuntime({ directory })
        const harness = await createHarness({ policy: { maxToolCalls: 1 }, trace })
        let executions = 0
        harness.tools.register({
            name: 'counter',
            description: 'counter',
            parameters: { type: 'object' },
            execute: async () => {
                executions += 1
                return 'ok'
            },
        })
        harness.llm.register(
            'mock',
            {
                models: ['budget'],
                async chat() {
                    return {
                        toolCalls: [
                            { id: 'call-1', name: 'counter', arguments: {} },
                            { id: 'call-2', name: 'counter', arguments: {} },
                        ],
                    }
                },
            },
            { defaultModel: 'budget' },
        )
        const agent = harness.agents.create({
            sessionId: harness.session.id,
            model: 'mock/budget',
            loop: harness.loop,
        })

        assert.equal(await agent.send('run'), '')
        assert.equal(executions, 1)
        const events = harness.sessions.get(harness.session.id).events
        const results = events.filter((event) => event.type === 'tool/result')
        assert.equal(results.length, 2)
        assert.equal(results[1].data.outcome, 'not_executed')
        assert.equal(results[1].data.skipped, true)
        assert.equal(results[1].data.recovered, false)
        assert.equal(results[1].data.skipReason, 'tool_call_limit')
        assert.equal(results[1].data.budgetStop, true)

        const files = await fs.readdir(directory)
        const run = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'))
        assert.equal(run.stopReason, 'tool_call_limit')
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('AgentLoop applies input/output, duration, and tool-failure budgets', async () => {
    const inputHarness = await createHarness({ policy: { maxInputTokens: 2 } })
    let inputCalls = 0
    inputHarness.llm.register(
        'mock',
        {
            models: ['input'],
            async chat() {
                inputCalls += 1
                return { content: 'input limited', usage: { inputTokens: 2 }, toolCalls: [] }
            },
        },
        { defaultModel: 'input' },
    )
    const inputAgent = inputHarness.agents.create({
        sessionId: inputHarness.session.id,
        model: 'mock/input',
        loop: inputHarness.loop,
    })
    assert.equal(await inputAgent.send('input'), 'input limited')
    assert.equal(inputCalls, 1)

    const outputHarness = await createHarness({ policy: { maxOutputTokens: 1 } })
    outputHarness.llm.register(
        'mock',
        {
            models: ['output'],
            async chat() {
                return { content: 'output limited', usage: { outputTokens: 1 }, toolCalls: [] }
            },
        },
        { defaultModel: 'output' },
    )
    const outputAgent = outputHarness.agents.create({
        sessionId: outputHarness.session.id,
        model: 'mock/output',
        loop: outputHarness.loop,
    })
    assert.equal(await outputAgent.send('output'), 'output limited')

    const clock = { value: 0 }
    const durationHarness = await createHarness({
        policy: { maxDurationMs: 5 },
    })
    durationHarness.llm.register(
        'mock',
        {
            models: ['duration'],
            async chat() {
                clock.value = 5
                return { content: 'time limited', toolCalls: [] }
            },
        },
        { defaultModel: 'duration' },
    )
    const durationAgent = durationHarness.agents.create({
        sessionId: durationHarness.session.id,
        model: 'mock/duration',
        loop: durationHarness.loop,
    })
    // The runtime clock is injected through the per-run option.
    assert.equal(await durationAgent.send('duration', { now: () => clock.value }), 'time limited')

    const failureHarness = await createHarness({ policy: { maxToolFailures: 1 } })
    failureHarness.tools.register({
        name: 'fail',
        description: 'fail',
        parameters: { type: 'object' },
        execute: async () => {
            throw new Error('failed')
        },
    })
    failureHarness.llm.register(
        'mock',
        {
            models: ['failure'],
            async chat() {
                return {
                    toolCalls: [{ id: 'failure-1', name: 'fail', arguments: {} }],
                }
            },
        },
        { defaultModel: 'failure' },
    )
    const failureAgent = failureHarness.agents.create({
        sessionId: failureHarness.session.id,
        model: 'mock/failure',
        loop: failureHarness.loop,
    })
    assert.equal(await failureAgent.send('failure'), '')
    assert.equal(
        failureHarness.sessions.get(failureHarness.session.id).events.at(-1).type,
        'tool/result',
    )
})

test('each Agent.send creates fresh per-run budgets', async () => {
    const harness = await createHarness({ policy: { maxSteps: 1 } })
    let calls = 0
    harness.tools.register({
        name: 'tick',
        description: 'tick',
        parameters: { type: 'object' },
        execute: async () => 'tick',
    })
    harness.llm.register(
        'mock',
        {
            models: ['fresh'],
            async chat() {
                calls += 1
                return calls === 1
                    ? { toolCalls: [{ id: 'tick-1', name: 'tick', arguments: {} }] }
                    : { content: 'fresh run', toolCalls: [] }
            },
        },
        { defaultModel: 'fresh' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/fresh',
        loop: harness.loop,
    })

    assert.equal(await agent.send('first'), '')
    assert.equal(await agent.send('second'), 'fresh run')
    assert.equal(calls, 2)
})

test('cancelled budget stop keeps protocol complete and trace reason cancelled', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-run-cancel-'))
    try {
        const trace = new TraceRuntime({ directory })
        const harness = await createHarness({ trace })
        const abort = new AbortController()
        harness.llm.register(
            'mock',
            {
                models: ['cancel'],
                async chat() {
                    return {
                        toolCalls: [
                            { id: 'cancel-1', name: 'missing', arguments: {} },
                            { id: 'cancel-2', name: 'missing', arguments: {} },
                        ],
                    }
                },
            },
            { defaultModel: 'cancel' },
        )
        harness.tools.register({
            name: 'missing',
            description: 'missing',
            parameters: { type: 'object' },
            execute: async () => {
                abort.abort()
                return 'done'
            },
        })
        const agent = harness.agents.create({
            sessionId: harness.session.id,
            model: 'mock/cancel',
            loop: harness.loop,
        })
        await assert.rejects(() => agent.send('cancel', { signal: abort.signal }), /cancelled/i)
        const files = await fs.readdir(directory)
        const run = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'))
        assert.equal(run.stopReason, 'cancelled')
        const results = harness.sessions
            .get(harness.session.id)
            .events.filter((event) => event.type === 'tool/result')
        assert.equal(results.length, 2)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})
