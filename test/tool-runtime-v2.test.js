import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../src/core/agent-runtime.js'
import { LlmRuntime } from '../src/core/llm-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../src/core/tool-runtime.js'
import * as sandboxPlugin from '../src/plugins/sandbox.js'
import * as systemPromptPlugin from '../src/plugins/system-prompt.js'
import * as toolsPlugin from '../src/plugins/tools.js'
import * as bashPlugin from '../src/tools/bash.js'

test('ToolRuntime validates registration and applies fail-closed metadata', () => {
    const tools = new ToolRuntime()
    assert.throws(() => tools.register({ execute() {} }), /tool.name is required/)
    assert.throws(() => tools.register({ name: 'missing-execute' }), /missing execute/)
    assert.throws(
        () =>
            tools.register({
                name: 'invalid-schema',
                parameters: { type: 'not-a-type' },
                execute() {},
            }),
        /unknown type|schema/i,
    )

    const dispose = tools.register({ name: 'defaulted', execute() {} })
    assert.deepEqual(pickMetadata(tools.get('defaulted')), {
        timeoutMs: null,
        readOnly: false,
        idempotent: false,
        concurrencySafe: false,
        sideEffect: true,
    })
    assert.throws(() => tools.register({ name: 'defaulted', execute() {} }), /duplicate tool/)
    dispose()

    tools.register({
        name: 'explicit',
        timeoutMs: 20,
        readOnly: true,
        idempotent: true,
        concurrencySafe: true,
        sideEffect: false,
        execute() {},
    })
    assert.deepEqual(pickMetadata(tools.get('explicit')), {
        timeoutMs: 20,
        readOnly: true,
        idempotent: true,
        concurrencySafe: true,
        sideEffect: false,
    })

    for (const key of ['readOnly', 'idempotent', 'concurrencySafe', 'sideEffect']) {
        assert.throws(
            () => tools.register({ name: `invalid-${key}`, [key]: 'false', execute() {} }),
            new TypeError(`tool.${key} must be a boolean`),
        )
    }
})

test('ToolRuntime validates arguments before execute without coercion or mutation', async () => {
    const tools = new ToolRuntime()
    let calls = 0
    tools.register({
        name: 'validated',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { count: { type: 'integer' } },
            required: ['count'],
        },
        execute: async () => {
            calls += 1
            return 'ok'
        },
    })

    const missing = await tools.execute('validated', {})
    const wrongType = await tools.execute('validated', { count: '1' })
    const additional = { count: 1, extra: true }
    const extraResult = await tools.execute('validated', additional)

    assert.equal(missing.errorCode, 'invalid_arguments')
    assert.equal(wrongType.errorCode, 'invalid_arguments')
    assert.equal(extraResult.errorCode, 'invalid_arguments')
    assert.deepEqual(additional, { count: 1, extra: true })
    assert.equal(calls, 0)

    const valid = await tools.execute('validated', { count: 1 })
    assert.equal(valid.isError, false)
    assert.equal(valid.errorCode, null)
    assert.equal(valid.metadata.timeout, false)
    assert.equal(valid.metadata.cancelled, false)
    assert.equal(calls, 1)
})

test('ToolRuntime normalizes unknown, execution, render, and finalize failures', async () => {
    const tools = new ToolRuntime()
    tools.register({
        name: 'throws',
        execute: async () => {
            throw new Error('boom')
        },
    })
    tools.register({
        name: 'render-throws',
        execute: async () => 'value',
        output: {
            render: () => {
                throw new Error('render boom')
            },
        },
    })
    tools.register({
        name: 'finalize-throws',
        execute: async () => 'value',
        finalizeContent: async () => {
            throw new Error('finalize boom')
        },
    })

    assert.equal((await tools.execute('missing', {})).errorCode, 'unknown_tool')
    assert.equal((await tools.execute('throws', {})).errorCode, 'execution_error')
    assert.equal((await tools.execute('render-throws', {})).errorCode, 'execution_error')
    assert.equal((await tools.execute('finalize-throws', {})).errorCode, 'execution_error')
})

test('ToolRuntime distinguishes tool timeout from parent cancellation', async () => {
    const tools = new ToolRuntime()
    let timeoutSignalSeen = false
    let timeoutCleanupComplete = false
    tools.register({
        name: 'timeout',
        timeoutMs: 10,
        execute: async (_args, { signal }) => {
            await waitForAbort(signal)
            timeoutSignalSeen = signal.aborted
            await delay(15)
            timeoutCleanupComplete = true
            return 'cleaned up'
        },
    })
    const timedOut = await tools.execute('timeout', {})
    assert.equal(timeoutSignalSeen, true)
    assert.equal(timeoutCleanupComplete, true)
    assert.equal(timedOut.errorCode, 'timeout')
    assert.equal(timedOut.metadata.timeout, true)
    assert.equal(timedOut.metadata.cancelled, false)

    const abort = new AbortController()
    tools.register({
        name: 'cancel',
        execute: async (_args, { signal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('parent stopped')), {
                    once: true,
                })
            }),
    })
    const pending = tools.execute('cancel', {}, { signal: abort.signal })
    abort.abort()
    const cancelled = await pending
    assert.equal(cancelled.errorCode, 'cancelled')
    assert.equal(cancelled.metadata.timeout, false)
    assert.equal(cancelled.metadata.cancelled, true)
})

test('sequential Tool execution waits for timeout cleanup before starting the next Tool', async () => {
    const tools = new ToolRuntime()
    const order = []
    tools.register({
        name: 'first',
        timeoutMs: 10,
        execute: async (_args, { signal }) => {
            await waitForAbort(signal)
            order.push('first-aborted')
            await delay(15)
            order.push('first-cleanup')
            return 'cleaned up'
        },
    })
    tools.register({
        name: 'second',
        execute: async () => {
            order.push('second-started')
            return 'done'
        },
    })

    const first = await tools.execute('first', {})
    order.push('first-returned')
    await tools.execute('second', {})

    assert.equal(first.errorCode, 'timeout')
    assert.deepEqual(order, ['first-aborted', 'first-cleanup', 'first-returned', 'second-started'])
})

test('Tool timeout is cleaned up after successful execution', async () => {
    const tools = new ToolRuntime()
    let aborted = false
    tools.register({
        name: 'fast',
        timeoutMs: 50,
        execute: async (_args, { signal }) => {
            signal.addEventListener('abort', () => {
                aborted = true
            })
            return 'done'
        },
    })
    const result = await tools.execute('fast', {})
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(result.errorCode, null)
    assert.equal(aborted, false)
})

test('AgentLoop records validation errorCode and continues with the next model turn', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    let executions = 0
    const statuses = []
    const trace = {
        startRun() {
            return {
                runId: 'validation-run',
                startStep() {
                    return {
                        startLlm() {},
                        finishLlm() {},
                        startToolCall() {
                            return { finish: (status) => statuses.push(status) }
                        },
                        finish() {},
                    }
                },
                async finish() {},
            }
        },
    }
    tools.register({
        name: 'validated',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { value: { type: 'string' } },
            required: ['value'],
        },
        execute: async () => {
            executions += 1
            return 'should not run'
        },
    })
    let calls = 0
    llm.register(
        'mock',
        {
            models: ['validation'],
            async chat() {
                calls += 1
                return calls === 1
                    ? { toolCalls: [{ id: 'invalid-1', name: 'validated', arguments: {} }] }
                    : { content: 'continued', toolCalls: [] }
            },
        },
        { defaultModel: 'validation' },
    )
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm, trace })
    const session = await sessions.create()
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/validation',
        loop,
    })

    assert.equal(await agent.send('validate'), 'continued')
    assert.equal(executions, 0)
    assert.deepEqual(statuses, ['error'])
    const result = sessions.get(session.id).events.find((event) => event.type === 'tool/result')
    assert.equal(result.data.errorCode, 'invalid_arguments')
})

test('AgentLoop passes full run/step/session/tool correlation to Tool execution', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    let executionContext
    const trace = {
        startRun() {
            return {
                runId: 'run-correlation',
                startStep() {
                    return {
                        stepId: 'step-correlation',
                        startLlm() {},
                        finishLlm() {},
                        startToolCall() {
                            return { finish() {} }
                        },
                        finish() {},
                    }
                },
                async finish() {},
            }
        },
    }
    tools.register({
        name: 'capture',
        execute: async (_args, execution) => {
            executionContext = execution
            return 'captured'
        },
    })
    let calls = 0
    llm.register(
        'mock',
        {
            models: ['correlation'],
            async chat() {
                calls += 1
                return calls === 1
                    ? { toolCalls: [{ id: 'tool-correlation', name: 'capture', arguments: {} }] }
                    : { content: 'done', toolCalls: [] }
            },
        },
        { defaultModel: 'correlation' },
    )
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm, trace })
    const session = await sessions.create()
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/correlation',
        loop,
    })

    assert.equal(await agent.send('capture'), 'done')
    assert.equal(executionContext.sessionId, session.id)
    assert.equal(executionContext.runId, 'run-correlation')
    assert.equal(executionContext.stepId, 'step-correlation')
    assert.equal(executionContext.toolCallId, 'tool-correlation')
    assert.equal(executionContext.agent, agent)
    assert.ok(executionContext.signal instanceof AbortSignal)
})

test('AgentLoop maps Tool timeout to timeout trace status and Session errorCode', async () => {
    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const statuses = []
    const trace = {
        startRun() {
            return {
                runId: 'timeout-run',
                startStep() {
                    return {
                        startLlm() {},
                        finishLlm() {},
                        startToolCall() {
                            return { finish: (status) => statuses.push(status) }
                        },
                        finish() {},
                    }
                },
                async finish() {},
            }
        },
    }
    tools.register({
        name: 'timeout',
        timeoutMs: 10,
        execute: async (_args, { signal }) => {
            await waitForAbort(signal)
            return 'cleaned up'
        },
    })
    let calls = 0
    llm.register(
        'mock',
        {
            models: ['timeout'],
            async chat() {
                calls += 1
                return calls === 1
                    ? { toolCalls: [{ id: 'timeout-1', name: 'timeout', arguments: {} }] }
                    : { content: 'continued', toolCalls: [] }
            },
        },
        { defaultModel: 'timeout' },
    )
    const loop = new AgentLoopRuntime({ sessions, systemPrompt, tools, llm, trace })
    const session = await sessions.create()
    const agent = agents.create({
        sessionId: session.id,
        model: 'mock/timeout',
        loop,
    })

    assert.equal(await agent.send('timeout'), 'continued')
    assert.deepEqual(statuses, ['timeout'])
    const result = sessions.get(session.id).events.find((event) => event.type === 'tool/result')
    assert.equal(result.data.errorCode, 'timeout')
})

test('builtin bash settles its process after abort before ToolRuntime returns timeout', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-bash-abort-'))
    const root = new Context()
    let childPid = null
    try {
        await root.plugin(systemPromptPlugin)
        await root.plugin(toolsPlugin)
        await root.plugin(sandboxPlugin, { workspace, autoApprove: true })
        await root.plugin(bashPlugin, { timeoutMs: 5_000, killGraceMs: 20 })

        const command = `echo $$ > bash.pid; exec node -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`
        const result = await root.tools.execute('bash', { command })
        childPid = Number(await fs.readFile(path.join(workspace, 'bash.pid'), 'utf8'))

        assert.equal(result.errorCode, 'timeout')
        assert.equal(result.metadata.timeout, true)
        assert.equal(isProcessAlive(childPid), false)
    } finally {
        if (childPid && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL')
        await root.fiber.dispose()
        await fs.rm(workspace, { recursive: true, force: true })
    }
})

function pickMetadata(tool) {
    return {
        timeoutMs: tool.timeoutMs,
        readOnly: tool.readOnly,
        idempotent: tool.idempotent,
        concurrencySafe: tool.concurrencySafe,
        sideEffect: tool.sideEffect,
    }
}

function waitForAbort(signal) {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error.code === 'ESRCH') return false
        throw error
    }
}
