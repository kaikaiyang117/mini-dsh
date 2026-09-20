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
import { TraceRuntime } from '../src/core/trace-runtime.js'

async function loadOnlyTrace(directory) {
    const entries = await fs.readdir(directory)
    assert.equal(entries.length, 1)
    return JSON.parse(await fs.readFile(path.join(directory, entries[0]), 'utf8'))
}

async function createHarness(trace) {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm, trace })
    const session = await sessions.create()

    return { sessions, tools, llm, agents, loop, session }
}

test('Agent run records identity, multiple steps, usage, and tool latency', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-'))
    const trace = new TraceRuntime({ directory })

    try {
        const { sessions, tools, llm, agents, loop, session } = await createHarness(trace)
        tools.register({
            name: 'clock',
            description: 'clock',
            parameters: { type: 'object' },
            execute: async () => '12:00',
        })

        let calls = 0
        llm.register(
            'mock',
            {
                models: ['trace-model'],
                async chat() {
                    calls += 1
                    if (calls === 1) {
                        return {
                            usage: {
                                inputTokens: 10,
                                outputTokens: 2,
                                reasoningTokens: 1,
                                cost: 0.01,
                            },
                            toolCalls: [{ id: 'tool-1', name: 'clock', arguments: {} }],
                        }
                    }
                    return {
                        usage: { inputTokens: 12, outputTokens: 3 },
                        content: '12:00',
                        toolCalls: [],
                    }
                },
            },
            { defaultModel: 'trace-model' },
        )

        const agent = agents.create({
            sessionId: session.id,
            model: 'mock/trace-model',
            loop,
        })

        assert.equal(await agent.send('what time is it'), '12:00')
        const run = await loadOnlyTrace(directory)

        assert.equal(run.sessionId, session.id)
        assert.equal(run.provider, 'mock')
        assert.equal(run.model, 'trace-model')
        assert.equal(run.stopReason, 'completed')
        assert.deepEqual(run.usage, {
            inputTokens: 22,
            outputTokens: 5,
            reasoningTokens: 1,
            cacheHitTokens: null,
            cacheMissTokens: null,
            cost: 0.01,
        })
        assert.equal(run.steps.length, 2)
        assert.equal(run.steps[0].toolCalls[0].toolCallId, 'tool-1')
        assert.equal(run.steps[0].toolCalls[0].status, 'completed')
        assert.ok(run.steps[0].llmLatencyMs >= 0)
        assert.ok(run.steps[0].toolCalls[0].durationMs >= 0)

        const events = sessions.get(session.id).events.slice(1)
        assert.ok(events.every((event) => event.data.runId === run.runId))
        assert.equal(events[1].data.stepId, run.steps[0].stepId)
        assert.equal(events.at(-1).data.stepId, run.steps[1].stepId)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('LLM latency starts at llm.chat and step duration includes the whole step', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-clock-'))
    const timestamps = [0, 100, 250, 300, 350, 400, 500, 600, 700, 900, 1000, 1100]
    const trace = new TraceRuntime({
        directory,
        now: () => {
            const timestamp = timestamps.shift()
            assert.notEqual(timestamp, undefined)
            return timestamp
        },
    })

    try {
        const { tools, llm, agents, loop, session } = await createHarness(trace)
        tools.register({
            name: 'clock',
            description: 'clock',
            parameters: { type: 'object' },
            execute: async () => 'done',
        })
        let calls = 0
        llm.register(
            'mock',
            {
                models: ['clock-model'],
                async chat() {
                    calls += 1
                    return calls === 1
                        ? { toolCalls: [{ id: 'tool-1', name: 'clock', arguments: {} }] }
                        : { content: 'done', toolCalls: [] }
                },
            },
            { defaultModel: 'clock-model' },
        )
        const agent = agents.create({ sessionId: session.id, model: 'mock/clock-model', loop })

        await agent.send('measure latency')
        const run = await loadOnlyTrace(directory)
        assert.equal(run.steps[0].llmLatencyMs, 50)
        assert.equal(run.steps[0].durationMs, 400)
        assert.equal(run.steps[1].llmLatencyMs, 200)
        assert.equal(run.steps[1].durationMs, 400)
        assert.equal(run.durationMs, 1100)
        assert.deepEqual(timestamps, [])
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('Cancelled multi-tool run records cancelled stop reason and every tool status', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-cancel-'))
    const trace = new TraceRuntime({ directory })
    const abort = new AbortController()

    try {
        const { tools, llm, agents, loop, session } = await createHarness(trace)
        tools.register({
            name: 'slow',
            description: 'slow',
            parameters: { type: 'object' },
            execute: async () => {
                abort.abort()
                return 'first'
            },
        })
        llm.register(
            'mock',
            {
                models: ['cancel-model'],
                async chat() {
                    return {
                        toolCalls: [
                            { id: 'tool-1', name: 'slow', arguments: {} },
                            { id: 'tool-2', name: 'slow', arguments: {} },
                        ],
                    }
                },
            },
            { defaultModel: 'cancel-model' },
        )

        const agent = agents.create({
            sessionId: session.id,
            model: 'mock/cancel-model',
            loop,
        })

        await assert.rejects(
            () => agent.send('cancel this', { signal: abort.signal }),
            /cancelled/i,
        )
        const run = await loadOnlyTrace(directory)

        assert.equal(run.stopReason, 'cancelled')
        assert.deepEqual(
            run.steps[0].toolCalls.map((call) => [call.toolCallId, call.status]),
            [
                ['tool-1', 'cancelled'],
                ['tool-2', 'cancelled'],
            ],
        )
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('Each Agent.send creates an independent run trace', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-runs-'))

    try {
        const { llm, agents, loop, session } = await createHarness(new TraceRuntime({ directory }))
        llm.register(
            'mock',
            {
                models: ['run-model'],
                async chat() {
                    return { content: 'done', toolCalls: [] }
                },
            },
            { defaultModel: 'run-model' },
        )
        const agent = agents.create({ sessionId: session.id, model: 'mock/run-model', loop })

        await agent.send('first')
        await agent.send('second')

        const files = await fs.readdir(directory)
        assert.equal(files.length, 2)
        const traces = await Promise.all(
            files.map(async (file) =>
                JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')),
            ),
        )
        assert.equal(new Set(traces.map((run) => run.runId)).size, 2)
        assert.deepEqual(
            traces.map((run) => run.stopReason),
            ['completed', 'completed'],
        )
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('LLM failure is recorded as internal_error without changing the thrown error', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-trace-error-'))

    try {
        const { llm, agents, loop, session } = await createHarness(new TraceRuntime({ directory }))
        llm.register(
            'mock',
            {
                models: ['error-model'],
                async chat() {
                    throw new Error('provider unavailable')
                },
            },
            { defaultModel: 'error-model' },
        )
        const agent = agents.create({ sessionId: session.id, model: 'mock/error-model', loop })

        await assert.rejects(() => agent.send('fail'), /provider unavailable/)
        const run = await loadOnlyTrace(directory)
        assert.equal(run.stopReason, 'internal_error')
        assert.equal(run.usage.cost, null)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('Trace persistence failure only emits a warning', async () => {
    const warnings = []
    const trace = new TraceRuntime({
        fileSystem: {
            mkdir: async () => {},
            writeFile: async () => {
                throw new Error('disk full')
            },
        },
        warn: (message) => warnings.push(message),
    })

    const run = trace.startRun({ sessionId: 'session-1', model: 'mock/model' })
    const result = await run.finish('completed')

    assert.equal(result.stopReason, 'completed')
    assert.match(warnings[0], /disk full/)
})
