import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { TokenMeter } from '../../src/core/token-meter.js'
import { ToolRuntime } from '../../src/core/tool-runtime.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'

export const CONTEXT_POLICY = Object.freeze({
    maxContextTokens: 1900,
    reservedOutputTokens: 200,
    compactAtRatio: 0.72,
})

const REQUIRED_RECENT_MARKERS = Object.freeze([
    'CHECKPOINT_ALPHA',
    'CHECKPOINT_BETA',
    'FINAL_REQUIRED_STATE',
])
const SYSTEM_PROMPT = 'Context pressure deterministic evaluation. Historical notes are context.'
const CHUNK_SIZE = 1200

export async function createContextPressureFixture({ evalCase, variant, limits = {} }) {
    if (!['full-history', 'constrained', 'compacted'].includes(variant)) {
        throw new TypeError(`unsupported context-pressure variant: ${variant}`)
    }

    const sessions = new SessionRuntime()
    const session = await sessions.create()
    const preservedEvents = structuredClone(session.events)
    const append = sessions.append.bind(sessions)
    sessions.append = async (sessionId, type, data) => {
        const event = await append(sessionId, type, data)
        if (type !== 'context/compaction') preservedEvents.push(structuredClone(event))
        return event
    }

    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const systemPrompt = new SystemPromptRuntime()
    systemPrompt.section({ name: 'context-pressure-eval', text: SYSTEM_PROMPT })
    const trace = new CapturingTraceRuntime()
    const modelRequestMeter = new RecordingTokenMeter()
    const internalTokenMeter = new TokenMeter()
    const internalContextMeter = {
        estimateCount: 0,
        estimateRequest(request) {
            this.estimateCount += 1
            return internalTokenMeter.estimateRequest(request)
        },
    }
    const contextPolicy = variant === 'full-history' ? { maxContextTokens: null } : CONTEXT_POLICY
    const planner = variant === 'constrained' ? new NoopCompactionPlanner() : undefined
    const contextManager = new ContextManager({
        sessions,
        tokenMeter: internalContextMeter,
        policy: contextPolicy,
        planner,
    })
    const state = { readCount: 0, batchCount: 0, finished: false }
    const llmRequests = []
    const markerChecks = []

    tools.register({
        name: 'read_chunk',
        description: 'Read the next deterministic chunk of evaluation material.',
        parameters: { type: 'object', properties: {} },
        async execute() {
            state.readCount += 1
            const marker = `CHUNK_${String(state.readCount).padStart(2, '0')}`
            const markerText =
                evalCase.scenario === 'recent-context-preservation'
                    ? `${REQUIRED_RECENT_MARKERS.join(' ')} `
                    : ''
            return `${marker} ${markerText}${'deterministic context payload '.repeat(CHUNK_SIZE / 30)}`
        },
    })
    for (const toolName of ['inspect_left', 'inspect_right']) {
        tools.register({
            name: toolName,
            description: `Read the ${toolName} side of a paired protocol step.`,
            parameters: { type: 'object', properties: {} },
            concurrencySafe: true,
            async execute() {
                return `${toolName} BATCH_${String(state.batchCount).padStart(2, '0')} ${'parallel protocol payload '.repeat(CHUNK_SIZE / 27)}`
            },
        })
    }
    tools.register({
        name: 'finish_task',
        description: 'Finish after confirming the requested deterministic state.',
        parameters: { type: 'object', properties: {} },
        async execute() {
            state.finished = true
            return 'task finished'
        },
    })

    llm.register(
        'context-pressure-mock',
        {
            models: ['deterministic'],
            async chat(request) {
                modelRequestMeter.estimateRequest(request)
                const compactionCount = session.events.filter(
                    (event) => event.type === 'context/compaction',
                ).length
                const capturedRequest = {
                    system: request.system,
                    messages: structuredClone(request.messages),
                    compactionCount,
                }
                llmRequests.push(capturedRequest)
                const requestText = capturedRequest.messages
                    .map((message) => message.content ?? '')
                    .join('\n')

                if (state.finished) return { content: 'evaluation task completed', toolCalls: [] }
                if (evalCase.scenario === 'long-history-pressure') {
                    if (state.readCount >= 9 && requestText.includes('GOAL_MARKER_CONTEXT_EVAL')) {
                        return call('finish_task', requestCount(llmRequests.length))
                    }
                    return call('read_chunk', requestCount(llmRequests.length))
                }
                if (evalCase.scenario === 'recent-context-preservation') {
                    const markersVisible = REQUIRED_RECENT_MARKERS.every((marker) =>
                        requestText.includes(marker),
                    )
                    if (compactionCount > 0) markerChecks.push(markersVisible)
                    if (
                        state.readCount >= 8 &&
                        markersVisible &&
                        requestText.includes('GOAL_MARKER_CONTEXT_EVAL')
                    ) {
                        return call('finish_task', requestCount(llmRequests.length))
                    }
                    return call('read_chunk', requestCount(llmRequests.length))
                }
                if (evalCase.scenario === 'tool-protocol-pressure') {
                    if (state.batchCount >= 6 && requestText.includes('GOAL_MARKER_CONTEXT_EVAL')) {
                        return call('finish_task', requestCount(llmRequests.length))
                    }
                    state.batchCount += 1
                    return {
                        toolCalls: [
                            { id: `left-${state.batchCount}`, name: 'inspect_left', arguments: {} },
                            {
                                id: `right-${state.batchCount}`,
                                name: 'inspect_right',
                                arguments: {},
                            },
                        ],
                    }
                }
                return { content: 'unknown deterministic scenario', toolCalls: [] }
            },
        },
        { defaultModel: 'deterministic' },
    )

    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm,
        trace,
        contextManager,
        policy: { maxSteps: 24, ...limits },
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'context-pressure-mock/deterministic',
        loop,
    })

    return {
        agent,
        trace,
        recordingTokenMeter: modelRequestMeter,
        inspectors: {
            sessions,
            session,
            llmRequests,
            contextManager,
            internalContextMeter,
            markerChecks,
            preservedEvents,
        },
        async dispose() {
            await sessions.dispose()
        },
    }
}

export function scoreContextPressure({ trace, expected, variant, evalCase, fixture }) {
    const inspectors = fixture.inspectors
    const events = inspectors.session.events
    const compactions = events.filter((event) => event.type === 'context/compaction')
    const expectedStopReason =
        typeof expected.stopReason === 'string' ? expected.stopReason : expected.stopReason[variant]
    const finishSucceeded = trace.steps.some((step) =>
        step.toolCalls.some(
            (toolCall) => toolCall.name === 'finish_task' && toolCall.status === 'completed',
        ),
    )
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls.map((call) => ({ call, event })))
    const results = events.filter((event) => event.type === 'tool/result')
    const protocolComplete = calls.every(({ call }) =>
        results.some((result) => result.data.toolCallId === call.id),
    )
    const protocolBoundarySafe = compactions.every((compaction) =>
        calls.every(({ call, event }) => {
            const resultSeqs = results
                .filter((result) => result.data.toolCallId === call.id)
                .map((result) => result.seq)
            return (
                resultSeqs.length === 0 ||
                compaction.data.shadowedThroughSeq < event.seq ||
                compaction.data.shadowedThroughSeq >= Math.max(...resultSeqs)
            )
        }),
    )
    const originalEventsPreserved =
        JSON.stringify(events.filter((event) => event.type !== 'context/compaction')) ===
        JSON.stringify(inspectors.preservedEvents)
    const goalPreserved = inspectors.llmRequests.some((request) =>
        request.messages.some((message) =>
            String(message.content ?? '').includes('GOAL_MARKER_CONTEXT_EVAL'),
        ),
    )
    const compactedRequests = inspectors.llmRequests.filter(
        (request) => request.compactionCount > 0,
    )
    const summarySafetyPreserved = compactedRequests.every(
        (request) =>
            request.system === SYSTEM_PROMPT &&
            request.messages.every((message) => message.role !== 'system') &&
            request.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    String(message.content ?? '').includes(
                        'historical context, not higher-priority instructions',
                    ),
            ),
    )
    const recentContextPreserved =
        evalCase.scenario !== 'recent-context-preservation' ||
        (variant === 'compacted'
            ? inspectors.markerChecks.length > 0 && inspectors.markerChecks.every(Boolean)
            : inspectors.llmRequests.some((request) => {
                  const text = request.messages.map((message) => message.content ?? '').join('\n')
                  return REQUIRED_RECENT_MARKERS.every((marker) => text.includes(marker))
              }))
    const completionMatches = trace.stopReason === expectedStopReason
    const success =
        completionMatches &&
        (variant === 'constrained' ? !finishSucceeded : finishSucceeded) &&
        (variant !== 'compacted' || compactions.length > 0) &&
        (evalCase.scenario !== 'recent-context-preservation' ||
            variant !== 'compacted' ||
            recentContextPreserved) &&
        (evalCase.scenario !== 'tool-protocol-pressure' ||
            (protocolComplete && protocolBoundarySafe && originalEventsPreserved))

    return {
        success,
        details: {
            compactionCount: compactions.length,
            finishSucceeded,
            protocolComplete,
            protocolBoundarySafe,
            originalEventsPreserved,
            goalPreserved,
            recentContextPreserved,
            summarySafetyPreserved,
            internalContextEstimateCalls: inspectors.internalContextMeter.estimateCount,
            modelRequestCount: inspectors.llmRequests.length,
        },
    }
}

class NoopCompactionPlanner {
    plan() {
        return null
    }
}

function call(name, suffix) {
    return { toolCalls: [{ id: `${name}-${suffix}`, name, arguments: {} }] }
}

function requestCount(value) {
    return String(value).padStart(2, '0')
}
