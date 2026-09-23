import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { JsonlSessionStore } from '../../src/core/jsonl-session-store.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../../src/core/tool-runtime.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'

const input = await onceMessage()
const { directory, sessionId, effectsDirectory } = input
const caseName = process.env.CRASH_CASE
try {
    if (process.env.CRASH_PHASE === 'crash') await crash(caseName, directory, effectsDirectory)
    else if (process.env.CRASH_PHASE === 'reopen') await reopen(directory, sessionId)
    else await resume(caseName, directory, sessionId)
} catch (error) {
    process.send?.({ type: 'error', message: error?.stack ?? String(error) })
    process.exitCode = 1
}

async function crash(name, directory, effects) {
    const sessions = new SessionRuntime({ store: new JsonlSessionStore({ directory }) })
    const session = await sessions.create()
    if (name === 'crash-after-user-message') {
        await sessions.append(session.id, 'user/message', { content: 'durable user message' })
    } else if (
        name === 'crash-after-side-effect-start' ||
        name === 'crash-after-tool-result-commit'
    ) {
        await crashThroughAgent(name, sessions, session, effects)
        return
    } else {
        await sessions.append(session.id, 'assistant/tool_calls', {
            runId: 'crash-run',
            stepId: 'crash-step',
            toolCalls: [{ id: 'call-1', name: 'side_effect_tool', arguments: {} }],
        })
        if (name === 'crash-after-side-effect-start' || name === 'crash-after-tool-result-commit') {
            await mkdir(effects, { recursive: true })
            await writeFile(path.join(effects, 'effect-1.txt'), 'APPLIED\n', 'utf8')
        }
        if (name === 'crash-after-tool-result-commit') {
            await sessions.append(session.id, 'tool/result', {
                toolCallId: 'call-1',
                name: 'side_effect_tool',
                isError: false,
                errorCode: null,
                content: 'APPLIED',
                runId: 'crash-run',
                stepId: 'crash-step',
            })
        } else if (name === 'torn-tool-result-tail') {
            await sessions.flush(session.id)
            const prefix = await readFile(path.join(directory, session.id, 'session.jsonl'))
            await appendFile(
                path.join(directory, session.id, 'session.jsonl'),
                '{"seq":3,"type":"tool/result","data":{"toolCallId":"call-1"',
                'utf8',
            )
            const damaged = await readFile(
                path.join(directory, session.id, 'session.jsonl'),
                'utf8',
            )
            const lastLine = damaged.trimEnd().split('\n').at(-1)
            process.send?.({
                type: 'checkpoint',
                phase: name,
                sessionId: session.id,
                eventCount: sessions.get(session.id).events.length,
                tornTailWritten: true,
                rawLengthBeforeCrash: Buffer.byteLength(damaged),
                validPrefixLength: prefix.length,
                tornTailValidBeforeCrash: (() => {
                    try {
                        JSON.parse(lastLine)
                        return false
                    } catch {
                        return true
                    }
                })(),
            })
            await new Promise(() => {})
            return
        }
    }
    await sessions.flush(session.id)
    process.send?.({
        type: 'checkpoint',
        phase: name,
        sessionId: session.id,
        eventCount: sessions.get(session.id).events.length,
    })
    await new Promise(() => {})
}

async function crashThroughAgent(name, sessions, session, effects) {
    const llm = new LlmRuntime()
    const tools = new ToolRuntime()
    const agents = new AgentRuntime()
    let requestCount = 0
    let executionCount = 0
    tools.register({
        name: 'side_effect_tool',
        sideEffect: true,
        idempotent: false,
        concurrencySafe: false,
        async execute() {
            executionCount += 1
            await sessions.flush(session.id)
            await mkdir(effects, { recursive: true })
            await writeFile(path.join(effects, 'effect-1.txt'), 'APPLIED\n', 'utf8')
            if (name === 'crash-after-side-effect-start') {
                process.send?.({
                    type: 'checkpoint',
                    phase: 'side-effect-applied',
                    sessionId: session.id,
                    eventCount: sessions.get(session.id).events.length,
                    toolCallDurable: sessions
                        .get(session.id)
                        .events.some(
                            (event) =>
                                event.type === 'assistant/tool_calls' &&
                                event.data.toolCalls?.some((call) => call.id === 'call-1'),
                        ),
                    executionCount,
                })
                await new Promise(() => {})
            }
            return 'APPLIED'
        },
    })
    llm.register(
        'crash-recovery',
        {
            models: ['deterministic'],
            async chat() {
                requestCount += 1
                if (requestCount === 1) {
                    return {
                        toolCalls: [{ id: 'call-1', name: 'side_effect_tool', arguments: {} }],
                    }
                }
                await sessions.flush(session.id)
                process.send?.({
                    type: 'checkpoint',
                    phase: 'tool-result-durable',
                    sessionId: session.id,
                    eventCount: sessions.get(session.id).events.length,
                    toolCallDurable: sessions
                        .get(session.id)
                        .events.some(
                            (event) =>
                                event.type === 'assistant/tool_calls' &&
                                event.data.toolCalls?.some((call) => call.id === 'call-1'),
                        ),
                    executionCount,
                })
                await new Promise(() => {})
            },
        },
        { defaultModel: 'deterministic' },
    )
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt: new SystemPromptRuntime(),
        tools,
        llm,
        policy: { maxSteps: 4 },
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'crash-recovery/deterministic',
        loop,
    })
    await agent.send('perform the side effect')
}

async function resume(name, directory, id) {
    const sessions = new SessionRuntime({ store: new JsonlSessionStore({ directory }) })
    const session = await sessions.open(id)
    const trace = new CapturingTraceRuntime()
    const llm = new LlmRuntime()
    const tools = new ToolRuntime()
    const agents = new AgentRuntime()
    const requests = []
    let executionCount = 0
    tools.register({
        name: 'side_effect_tool',
        async execute() {
            executionCount += 1
            return 'APPLIED'
        },
    })
    llm.register(
        'crash-recovery',
        {
            models: ['deterministic'],
            async chat(request) {
                requests.push(structuredClone(request.messages))
                const messages = request.messages
                const hasUser = messages.some(
                    (message) =>
                        message.role === 'user' && message.content === 'durable user message',
                )
                const hasUnknown = messages.some(
                    (message) =>
                        message.role === 'tool' &&
                        String(message.content).includes('actual outcome is unknown'),
                )
                const hasApplied = messages.some(
                    (message) =>
                        message.role === 'tool' && String(message.content).includes('APPLIED'),
                )
                if (name === 'crash-after-user-message' && !hasUser)
                    throw new Error('resume request lost durable user message')
                if (name === 'crash-after-side-effect-start' && !hasUnknown)
                    throw new Error('resume request lost unknown recovery result')
                if (name === 'crash-after-tool-result-commit' && !hasApplied)
                    throw new Error('resume request lost durable tool result')
                return { content: 'continued after recovery', toolCalls: [] }
            },
        },
        { defaultModel: 'deterministic' },
    )
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt: new SystemPromptRuntime(),
        tools,
        llm,
        trace,
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'crash-recovery/deterministic',
        loop,
    })
    await agent.send('continue')
    const events = sessions.get(id).events
    const traceValue = trace.latest()
    const raw = await readFile(path.join(directory, id, 'session.jsonl'), 'utf8')
    let rawLinesValid = true
    try {
        for (const line of raw.trimEnd().split('\n').filter(Boolean)) JSON.parse(line)
    } catch {
        rawLinesValid = false
    }
    let externalEffectCount = 0
    try {
        externalEffectCount =
            (await readFile(path.join(effectsDirectory, 'effect-1.txt'), 'utf8')).trim() ===
            'APPLIED'
                ? 1
                : 0
    } catch {}
    process.send?.({
        type: 'result',
        sessionId: id,
        events,
        trace: traceValue,
        requests,
        executionCount,
        externalEffectCount,
        rawLinesValid,
    })
    await sessions.dispose()
}

async function reopen(directory, id) {
    const sessions = new SessionRuntime({ store: new JsonlSessionStore({ directory }) })
    const session = await sessions.open(id)
    process.send?.({ type: 'result', events: session.events })
    await sessions.dispose()
}

function onceMessage() {
    return new Promise((resolve) => process.once('message', resolve))
}
