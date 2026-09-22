import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import { maxParallelToolCallsFromEnv, ToolScheduler } from '../src/core/tool-scheduler.js'
import { TraceRuntime } from '../src/core/trace-runtime.js'

test('ToolScheduler partitions only explicitly concurrency-safe calls around barriers', () => {
    const tools = new ToolRuntime()
    tools.register({ name: 'safe', concurrencySafe: true, execute() {} })
    tools.register({ name: 'exclusive', concurrencySafe: false, execute() {} })
    tools.register({ name: 'read-only', readOnly: true, sideEffect: false, execute() {} })
    const scheduler = new ToolScheduler({ tools })
    const calls = [
        call('1', 'safe'),
        call('2', 'safe'),
        call('3', 'exclusive'),
        call('4', 'safe'),
        call('5', 'read-only'),
        call('6', 'missing'),
    ]

    assert.deepEqual(
        scheduler.partition(calls).map((group) => ({
            type: group.type,
            calls: group.calls.map((entry) => entry.call.id),
        })),
        [
            { type: 'parallel', calls: ['1', '2'] },
            { type: 'exclusive', calls: ['3'] },
            { type: 'parallel', calls: ['4'] },
            { type: 'exclusive', calls: ['5'] },
            { type: 'exclusive', calls: ['6'] },
        ],
    )
})

test('maxParallelToolCalls defaults to four, supports env configuration, and rejects invalid values', () => {
    const tools = new ToolRuntime()
    assert.equal(new ToolScheduler({ tools }).maxParallelToolCalls, 4)
    assert.equal(maxParallelToolCallsFromEnv({ MINI_DSH_MAX_PARALLEL_TOOL_CALLS: '2' }), 2)
    assert.equal(maxParallelToolCallsFromEnv({}), 4)
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, null]) {
        assert.throws(
            () => new ToolScheduler({ tools, maxParallelToolCalls: value }),
            /positive integer/,
        )
    }
    assert.throws(
        () => maxParallelToolCallsFromEnv({ MINI_DSH_MAX_PARALLEL_TOOL_CALLS: 'none' }),
        /positive integer/,
    )
})

test('safe calls overlap while completion order does not change Session order, mapping, or replay', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-parallel-trace-'))
    try {
        const harness = await createHarness({ trace: new TraceRuntime({ directory }) })
        const release = deferred()
        const completed = []
        let started = 0
        harness.tools.register({
            name: 'safe',
            concurrencySafe: true,
            async execute({ id }) {
                started += 1
                if (started === 2) release.resolve()
                await release.promise
                await delay(id === 'a' ? 30 : 5)
                completed.push(id)
                return `result-${id}`
            },
        })
        const toolCalls = [call('call-a', 'safe', { id: 'a' }), call('call-b', 'safe', { id: 'b' })]
        let replayedToolMessages
        registerTurn(harness.llm, 'parallel-order', toolCalls, (messages) => {
            replayedToolMessages = messages.filter((message) => message.role === 'tool')
        })

        const agent = harness.agent('parallel-order')
        assert.equal(await agent.send('run in parallel'), 'done')
        assert.deepEqual(completed, ['b', 'a'])

        const results = toolResults(harness)
        assert.deepEqual(
            results.map((event) => event.data.toolCallId),
            ['call-a', 'call-b'],
        )
        assert.deepEqual(
            results.map((event) => event.data.content),
            ['result-a', 'result-b'],
        )
        assert.deepEqual(
            replayedToolMessages.map((message) => message.tool_call_id),
            ['call-a', 'call-b'],
        )
        assertProtocolComplete(harness)

        const trace = await loadOnlyTrace(directory)
        const [first, second] = trace.steps[0].toolCalls
        assert.equal(first.toolCallId, 'call-a')
        assert.equal(second.toolCallId, 'call-b')
        assert.ok(Date.parse(first.startedAt) < Date.parse(second.endedAt))
        assert.ok(Date.parse(second.startedAt) < Date.parse(first.endedAt))
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('exclusive calls are serial barriers between bounded parallel groups', async () => {
    const harness = await createHarness()
    const events = []
    let runningSafe = 0
    harness.tools.register({
        name: 'safe',
        concurrencySafe: true,
        async execute({ id }) {
            runningSafe += 1
            events.push(`safe-${id}-start`)
            await delay(10)
            events.push(`safe-${id}-end`)
            runningSafe -= 1
            return id
        },
    })
    harness.tools.register({
        name: 'exclusive',
        concurrencySafe: false,
        async execute({ id }) {
            assert.equal(runningSafe, 0)
            events.push(`exclusive-${id}-start`)
            await delay(5)
            events.push(`exclusive-${id}-end`)
            return id
        },
    })
    registerTurn(harness.llm, 'barriers', [
        call('safe-a', 'safe', { id: 'a' }),
        call('safe-b', 'safe', { id: 'b' }),
        call('exclusive-x', 'exclusive', { id: 'x' }),
        call('exclusive-y', 'exclusive', { id: 'y' }),
        call('safe-c', 'safe', { id: 'c' }),
        call('safe-d', 'safe', { id: 'd' }),
    ])

    assert.equal(await harness.agent('barriers').send('barriers'), 'done')
    assert.ok(events.indexOf('safe-a-end') < events.indexOf('exclusive-x-start'))
    assert.ok(events.indexOf('safe-b-end') < events.indexOf('exclusive-x-start'))
    assert.ok(events.indexOf('exclusive-x-end') < events.indexOf('exclusive-y-start'))
    assert.ok(events.indexOf('exclusive-y-end') < events.indexOf('safe-c-start'))
    assert.ok(events.indexOf('exclusive-y-end') < events.indexOf('safe-d-start'))
})

test('parallel worker pool never exceeds maxParallelToolCalls', async () => {
    const harness = await createHarness({ maxParallelToolCalls: 2 })
    let running = 0
    let maximum = 0
    harness.tools.register({
        name: 'bounded',
        concurrencySafe: true,
        async execute({ id }) {
            running += 1
            maximum = Math.max(maximum, running)
            await delay(10)
            running -= 1
            return id
        },
    })
    registerTurn(
        harness.llm,
        'bounded',
        Array.from({ length: 7 }, (_, index) => call(`bounded-${index}`, 'bounded', { id: index })),
    )

    assert.equal(await harness.agent('bounded').send('bounded'), 'done')
    assert.equal(maximum, 2)
})

test('parallel execution errors and Tool timeouts stay isolated from independent calls', async () => {
    const harness = await createHarness()
    let successful = false
    harness.tools.register({
        name: 'error',
        concurrencySafe: true,
        async execute() {
            throw new Error('isolated failure')
        },
    })
    harness.tools.register({
        name: 'timeout',
        concurrencySafe: true,
        timeoutMs: 10,
        async execute(_args, { signal }) {
            await waitForAbort(signal)
            await delay(5)
            return 'cleaned up'
        },
    })
    harness.tools.register({
        name: 'success',
        concurrencySafe: true,
        async execute() {
            await delay(20)
            successful = true
            return 'success'
        },
    })
    registerTurn(harness.llm, 'isolated', [
        call('error-call', 'error'),
        call('timeout-call', 'timeout'),
        call('success-call', 'success'),
    ])

    assert.equal(await harness.agent('isolated').send('isolate failures'), 'done')
    assert.equal(successful, true)
    assert.deepEqual(
        toolResults(harness).map((event) => event.data.errorCode),
        ['execution_error', 'timeout', null],
    )
})

test('external cancellation cancels running calls and skips queued calls with complete protocol', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-parallel-cancel-'))
    try {
        const abort = new AbortController()
        const harness = await createHarness({
            maxParallelToolCalls: 2,
            trace: new TraceRuntime({ directory }),
        })
        let executions = 0
        harness.tools.register({
            name: 'cancel-safe',
            concurrencySafe: true,
            async execute(_args, { signal }) {
                executions += 1
                if (executions === 2) abort.abort()
                await waitForAbort(signal)
                await delay(5)
                return 'cleaned up'
            },
        })
        registerTurn(
            harness.llm,
            'external-cancel',
            Array.from({ length: 4 }, (_, index) => call(`cancel-${index}`, 'cancel-safe')),
        )

        await assert.rejects(
            () => harness.agent('external-cancel').send('cancel', { signal: abort.signal }),
            /cancelled/i,
        )
        assert.equal(executions, 2)
        const results = toolResults(harness)
        assert.equal(results.length, 4)
        assert.deepEqual(
            results.map((event) => event.data.toolCallId),
            ['cancel-0', 'cancel-1', 'cancel-2', 'cancel-3'],
        )
        assert.deepEqual(
            results.map((event) => event.data.outcome ?? null),
            [null, null, 'not_executed', 'not_executed'],
        )
        assertProtocolComplete(harness)

        const trace = await loadOnlyTrace(directory)
        assert.equal(trace.stopReason, 'cancelled')
        assert.notEqual(trace.steps[0].toolCalls[0].startedAt, null)
        assert.notEqual(trace.steps[0].toolCalls[1].startedAt, null)
        assert.equal(trace.steps[0].toolCalls[2].startedAt, null)
        assert.equal(trace.steps[0].toolCalls[3].startedAt, null)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('scheduler failure after tool-call commit appends one synthetic result per call', async () => {
    const scheduler = {
        async execute() {
            throw new Error('injected scheduler dispatch failure')
        },
    }
    const harness = await createHarness({ scheduler })
    let executions = 0
    harness.tools.register({
        name: 'committed',
        async execute() {
            executions += 1
            return 'must not execute'
        },
    })
    registerTurn(harness.llm, 'scheduler-failure', [call('committed-1', 'committed')])

    await assert.rejects(
        () => harness.agent('scheduler-failure').send('trigger committed dispatch failure'),
        /injected scheduler dispatch failure/,
    )

    const events = harness.sessions.get(harness.session.id).events
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls.map(({ id }) => id))
    const results = events.filter((event) => event.type === 'tool/result')
    assert.deepEqual(calls, ['committed-1'])
    assert.deepEqual(
        results.map((event) => event.data.toolCallId),
        calls,
    )
    assert.equal(results[0].data.outcome, 'not_executed')
    assert.equal(results[0].data.skipReason, 'internal_error')
    assert.equal(executions, 0)
})

test('run deadline cancels running calls, skips queued calls, and remains time_limit at run level', async () => {
    const harness = await createHarness({
        maxParallelToolCalls: 2,
        policy: { maxDurationMs: 20 },
    })
    let executions = 0
    let cleanups = 0
    harness.tools.register({
        name: 'deadline-safe',
        concurrencySafe: true,
        async execute(_args, { signal }) {
            executions += 1
            await waitForAbort(signal)
            await delay(5)
            cleanups += 1
            return 'cleaned up'
        },
    })
    registerTurn(
        harness.llm,
        'deadline',
        Array.from({ length: 4 }, (_, index) => call(`deadline-${index}`, 'deadline-safe')),
    )
    let stopped

    assert.equal(
        await harness.agent('deadline').send('deadline', {
            onStop: (decision) => {
                stopped = decision
            },
        }),
        '',
    )
    assert.equal(stopped.stopReason, 'time_limit')
    assert.equal(executions, 2)
    assert.equal(cleanups, 2)
    assert.deepEqual(
        toolResults(harness).map((event) => event.data.outcome ?? null),
        [null, null, 'not_executed', 'not_executed'],
    )
    assertProtocolComplete(harness)
})

test('tool-call budget admission never starts excess calls and still completes the protocol', async () => {
    const harness = await createHarness({
        maxParallelToolCalls: 4,
        policy: { maxToolCalls: 2 },
    })
    const executions = []
    harness.tools.register({
        name: 'budget-safe',
        concurrencySafe: true,
        async execute({ id }) {
            executions.push(id)
            await delay(10)
            return `completed-${id}`
        },
    })
    registerTurn(
        harness.llm,
        'budget',
        ['A', 'B', 'C', 'D'].map((id) => call(`budget-${id}`, 'budget-safe', { id })),
    )
    let stopped

    assert.equal(
        await harness.agent('budget').send('budget', {
            onStop: (decision) => {
                stopped = decision
            },
        }),
        '',
    )
    assert.deepEqual(executions, ['A', 'B'])
    assert.equal(stopped.stopReason, 'tool_call_limit')
    assert.equal(stopped.state.toolCalls, 2)
    const results = toolResults(harness)
    assert.equal(results.length, 4)
    assert.deepEqual(
        results.slice(0, 2).map((event) => ({
            content: event.data.content,
            errorCode: event.data.errorCode,
            outcome: event.data.outcome ?? null,
        })),
        [
            { content: 'completed-A', errorCode: null, outcome: null },
            { content: 'completed-B', errorCode: null, outcome: null },
        ],
    )
    assert.deepEqual(
        results.slice(2).map((event) => event.data.outcome),
        ['not_executed', 'not_executed'],
    )
    assert.deepEqual(
        results.slice(2).map((event) => event.data.skipReason),
        ['tool_call_limit', 'tool_call_limit'],
    )
    assert.deepEqual(
        results.slice(2).map((event) => event.data.retryable),
        [false, false],
    )
    assertProtocolComplete(harness)
})

test('synchronous Tool observers cannot interrupt parallel execution or Session results', async () => {
    const harness = await createHarness()
    const executions = []
    harness.tools.register({
        name: 'observed',
        concurrencySafe: true,
        async execute({ id }) {
            executions.push(id)
            await delay(5)
            return `result-${id}`
        },
    })
    registerTurn(harness.llm, 'observer-throw', [
        call('observer-A', 'observed', { id: 'A' }),
        call('observer-B', 'observed', { id: 'B' }),
    ])

    assert.equal(
        await harness.agent('observer-throw').send('observe', {
            onToolCall() {
                throw new Error('onToolCall observer failed')
            },
            onToolResult() {
                throw new Error('onToolResult observer failed')
            },
        }),
        'done',
    )
    assert.deepEqual(executions, ['A', 'B'])
    assert.deepEqual(
        toolResults(harness).map((event) => event.data.toolCallId),
        ['observer-A', 'observer-B'],
    )
    assertProtocolComplete(harness)
})

test('rejected asynchronous Tool observers are detached from the Agent run outcome', async () => {
    const harness = await createHarness()
    harness.tools.register({
        name: 'async-observed',
        concurrencySafe: true,
        async execute({ id }) {
            await delay(5)
            return `result-${id}`
        },
    })
    registerTurn(harness.llm, 'observer-rejection', [
        call('async-A', 'async-observed', { id: 'A' }),
        call('async-B', 'async-observed', { id: 'B' }),
    ])
    let callObservers = 0
    const callObserver = () => {
        callObservers += 1
        if (callObservers === 1) return Promise.reject(new Error('async observer failed'))
        return new Promise(() => {})
    }

    assert.equal(
        await Promise.race([
            harness.agent('observer-rejection').send('observe async', {
                onToolCall: callObserver,
                onToolResult: () => Promise.reject(new Error('async result observer failed')),
            }),
            delay(100).then(() => 'observer-timeout'),
        ]),
        'done',
    )
    assert.equal(toolResults(harness).length, 2)
    assertProtocolComplete(harness)
})

async function createHarness({ maxParallelToolCalls, policy, trace, scheduler } = {}) {
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
        maxParallelToolCalls,
        scheduler,
    })
    const session = await sessions.create()
    return {
        sessions,
        tools,
        llm,
        session,
        agent(model) {
            return agents.create({
                sessionId: session.id,
                model: `mock/${model}`,
                loop,
            })
        },
    }
}

function registerTurn(llm, model, toolCalls, inspectMessages) {
    let turn = 0
    llm.register(
        'mock',
        {
            models: [model],
            async chat({ messages }) {
                turn += 1
                if (turn === 1) return { toolCalls }
                inspectMessages?.(messages)
                return { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: model },
    )
}

function call(id, name, args = {}) {
    return { id, name, arguments: args }
}

function toolResults(harness) {
    return harness.sessions
        .get(harness.session.id)
        .events.filter((event) => event.type === 'tool/result')
}

function assertProtocolComplete(harness) {
    const messages = harness.sessions.deriveMessages(harness.session.id)
    const requested = messages
        .filter((message) => message.tool_calls)
        .flatMap((message) => message.tool_calls.map((item) => item.id))
    const answered = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id)
    assert.deepEqual(answered, requested)
}

async function loadOnlyTrace(directory) {
    const files = await fs.readdir(directory)
    assert.equal(files.length, 1)
    return JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'))
}

function deferred() {
    const state = {}
    state.promise = new Promise((resolve) => {
        state.resolve = resolve
    })
    return state
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForAbort(signal) {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}
