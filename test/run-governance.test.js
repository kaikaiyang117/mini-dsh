import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { CostEstimator } from '../src/core/cost-estimator.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { normalizeRunPolicy } from '../src/core/run-controller.js'
import { runPolicyFromEnv } from '../src/core/run-policy-config.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'

test('CostEstimator prices cache tokens as an input partition', () => {
    const estimator = new CostEstimator({
        pricing: {
            'mock/cache': {
                inputPer1k: 1,
                outputPer1k: 2,
                cacheHitPer1k: 0.1,
                cacheMissPer1k: 0.5,
            },
        },
    })
    const usage = estimator.estimate(
        {
            inputTokens: 1000,
            outputTokens: 500,
            cacheHitTokens: 600,
            cacheMissTokens: 200,
            cost: null,
        },
        { provider: 'mock', model: 'cache' },
    )

    // 200 uncached * 1 + 600 hit * .1 + 200 miss * .5 + 500 output * 2.
    assert.equal(Number(usage.cost.toFixed(12)), 1.36)
})

test('CostEstimator boundary cases stay unknown instead of inventing cost', () => {
    const estimator = new CostEstimator({ pricing: { default: { inputPer1k: 1, outputPer1k: 2 } } })
    assert.equal(estimator.estimate({ inputTokens: 100, outputTokens: 20 }).cost, 0.14)
    assert.equal(
        estimator.estimate({ inputTokens: 100, outputTokens: 20, cacheHitTokens: 101 }).cost,
        null,
    )
    assert.equal(estimator.estimate({ inputTokens: 100 }).cost, null)
    assert.equal(estimator.estimate({ inputTokens: 100, outputTokens: 20, cost: 0 }).cost, 0)
})

test('production policy wiring supplies defaults and supports null env overrides', () => {
    assert.deepEqual(runPolicyFromEnv({}), {
        maxSteps: 32,
        maxToolCalls: 64,
        maxDurationMs: 600000,
        maxInputTokens: null,
        maxOutputTokens: null,
        maxCost: null,
        maxToolFailures: 3,
    })
    assert.deepEqual(
        runPolicyFromEnv({
            MINI_DSH_MAX_STEPS: '8',
            MINI_DSH_MAX_TOOL_CALLS: 'null',
            MINI_DSH_MAX_DURATION_MS: '2500',
            MINI_DSH_MAX_COST: '0.05',
        }),
        {
            maxSteps: 8,
            maxToolCalls: null,
            maxDurationMs: 2500,
            maxInputTokens: null,
            maxOutputTokens: null,
            maxCost: 0.05,
            maxToolFailures: 3,
        },
    )
})

test('integer policy fields reject fractions and negative values', () => {
    for (const key of [
        'maxSteps',
        'maxToolCalls',
        'maxInputTokens',
        'maxOutputTokens',
        'maxToolFailures',
    ]) {
        assert.throws(() => normalizeRunPolicy({ [key]: 1.5 }), /non-negative integer/)
        assert.throws(() => normalizeRunPolicy({ [key]: -1 }), /non-negative integer/)
    }
    assert.deepEqual(normalizeRunPolicy({ maxDurationMs: 1.5, maxCost: 0.25 }).maxCost, 0.25)
})

test('CostEstimator supplies model estimated cost without provider pricing in RunController', async () => {
    const harness = await createHarness({
        policy: { maxCost: 1 },
        costEstimator: new CostEstimator({
            pricing: { 'mock/priced': { inputPer1k: 1, outputPer1k: 2 } },
        }),
    })
    harness.llm.register(
        'mock',
        {
            models: ['priced'],
            async chat() {
                return {
                    content: 'priced',
                    usage: { inputTokens: 1000, outputTokens: 0, cost: null },
                    toolCalls: [],
                }
            },
        },
        { defaultModel: 'priced' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/priced',
        loop: harness.loop,
    })
    let stop
    assert.equal(await agent.send('cost', { onStop: (decision) => (stop = decision) }), 'priced')
    assert.equal(stop.stopReason, 'cost_limit')
    assert.equal(stop.state.cost, 1)
})

test('run deadline aborts a slow LLM and maps to time_limit', async () => {
    const harness = await createHarness({ policy: { maxDurationMs: 10 } })
    let aborted = false
    harness.llm.register(
        'mock',
        {
            models: ['slow-llm'],
            async chat({ signal }) {
                await waitForAbort(signal)
                aborted = true
                throw new Error('deadline abort')
            },
        },
        { defaultModel: 'slow-llm' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/slow-llm',
        loop: harness.loop,
    })
    let stop
    assert.equal(await agent.send('slow', { onStop: (decision) => (stop = decision) }), '')
    assert.equal(aborted, true)
    assert.equal(stop.stopReason, 'time_limit')
})

test('run deadline aborts a slow tool and passes the combined signal', async () => {
    const harness = await createHarness({ policy: { maxDurationMs: 10 } })
    let aborted = false
    harness.tools.register({
        name: 'slow',
        description: 'slow',
        parameters: { type: 'object' },
        async execute(_args, { signal }) {
            await waitForAbort(signal)
            aborted = true
            throw new Error('deadline abort')
        },
    })
    harness.llm.register(
        'mock',
        {
            models: ['slow-tool'],
            async chat() {
                return { toolCalls: [{ id: 'slow-1', name: 'slow', arguments: {} }] }
            },
        },
        { defaultModel: 'slow-tool' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/slow-tool',
        loop: harness.loop,
    })
    let stop
    assert.equal(await agent.send('slow', { onStop: (decision) => (stop = decision) }), '')
    assert.equal(aborted, true)
    assert.equal(stop.stopReason, 'time_limit')
    assert.equal(
        harness.sessions
            .get(harness.session.id)
            .events.find((event) => event.type === 'tool/result').data.errorCode,
        'cancelled',
    )
})

test('external abort remains cancelled even with a run deadline', async () => {
    const harness = await createHarness({ policy: { maxDurationMs: 100 } })
    const abort = new AbortController()
    harness.llm.register(
        'mock',
        {
            models: ['cancelled'],
            async chat({ signal }) {
                await waitForAbort(signal)
                throw new Error('external abort')
            },
        },
        { defaultModel: 'cancelled' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/cancelled',
        loop: harness.loop,
    })
    let stop
    const pending = agent.send('cancel', {
        signal: abort.signal,
        onStop: (decision) => (stop = decision),
    })
    setTimeout(() => abort.abort(), 5)
    await assert.rejects(pending, /cancelled/i)
    assert.equal(stop.stopReason, 'cancelled')
})

test('onStop callback failure cannot change a successful Agent.send outcome', async () => {
    const harness = await createHarness()
    harness.llm.register(
        'mock',
        {
            models: ['on-stop'],
            async chat() {
                return { content: 'success', toolCalls: [] }
            },
        },
        { defaultModel: 'on-stop' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/on-stop',
        loop: harness.loop,
    })

    assert.equal(
        await agent.send('callback', {
            onStop: () => {
                throw new Error('observer failed')
            },
        }),
        'success',
    )
})

test('onStop callback failure cannot replace the original Agent.send error', async () => {
    const harness = await createHarness()
    const original = new Error('llm failed')
    harness.llm.register(
        'mock',
        {
            models: ['on-stop-error'],
            async chat() {
                throw original
            },
        },
        { defaultModel: 'on-stop-error' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/on-stop-error',
        loop: harness.loop,
    })

    await assert.rejects(
        () =>
            agent.send('callback', {
                onStop: () => {
                    throw new Error('observer failed')
                },
            }),
        (error) => error === original,
    )
})

test('onStop receives controller snapshot captured before trace persistence', async () => {
    const clock = { value: 0 }
    const trace = {
        startRun() {
            return {
                runId: 'trace-run',
                startStep() {
                    return {
                        startLlm() {},
                        finishLlm() {},
                        finish() {},
                    }
                },
                async finish() {
                    clock.value = 100
                },
            }
        },
    }
    const harness = await createHarness({ trace })
    harness.llm.register(
        'mock',
        {
            models: ['snapshot'],
            async chat() {
                return {
                    content: 'snapshot',
                    usage: { inputTokens: 1, outputTokens: 1 },
                    toolCalls: [],
                }
            },
        },
        { defaultModel: 'snapshot' },
    )
    const agent = harness.agents.create({
        sessionId: harness.session.id,
        model: 'mock/snapshot',
        loop: harness.loop,
    })
    let stop
    await agent.send('snapshot', {
        now: () => clock.value,
        onStop: (decision) => {
            stop = decision
        },
    })

    assert.equal(stop.stopReason, 'completed')
    assert.equal(stop.state.elapsedMs, 0)
})

async function createHarness({ policy, costEstimator, trace } = {}) {
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
        policy,
        costEstimator,
        trace,
    })
    const session = await sessions.create()
    return { sessions, tools, llm, agents, loop, session }
}

function waitForAbort(signal) {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}
