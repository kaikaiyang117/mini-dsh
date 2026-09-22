import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { SemanticProgressDetector } from '../../src/core/semantic-progress-detector.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { ToolRuntime } from '../../src/core/tool-runtime.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'

export async function createProgressFixture(evalCase, variant) {
    if (!['baseline', 'remind', 'guarded'].includes(variant)) {
        throw new TypeError(`unsupported progress variant: ${variant}`)
    }

    const sessions = new SessionRuntime()
    const systemPrompt = new SystemPromptRuntime()
    systemPrompt.section({ name: 'progress-eval', text: 'Progress Eval mock system.' })
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const session = await sessions.create()
    const llmRequests = []
    const recordingTokenMeter = new RecordingTokenMeter()
    const contextManager = new ContextManager({ sessions, tokenMeter: recordingTokenMeter })
    const trace = new CapturingTraceRuntime()
    const state = { searchCount: 0, refinementCount: 0, value: 0, targetExecuted: false }

    tools.register({
        name: 'empty_search',
        description: 'Returns no matches for the supplied search query.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        concurrencySafe: true,
        async execute() {
            return ''
        },
    })
    tools.register({
        name: 'refine_search',
        description: 'Returns a new refinement result.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        async execute() {
            state.refinementCount += 1
            return `result ${String.fromCharCode(64 + state.refinementCount)}`
        },
    })
    tools.register({
        name: 'read_state',
        description: 'Reads current state.',
        parameters: { type: 'object' },
        concurrencySafe: true,
        async execute() {
            return `state ${state.value}`
        },
    })
    tools.register({
        name: 'change_state',
        description: 'Changes the state.',
        parameters: { type: 'object' },
        async execute() {
            state.value = 1
            return 'state changed'
        },
    })
    tools.register({
        name: 'useful_parallel',
        description: 'Returns new useful information.',
        parameters: { type: 'object' },
        concurrencySafe: true,
        async execute() {
            return 'new useful parallel information'
        },
    })
    tools.register({
        name: 'target',
        description: 'Completes the requested task.',
        parameters: { type: 'object' },
        async execute() {
            state.targetExecuted = true
            return 'target found'
        },
    })

    llm.register(
        'progress-mock',
        {
            models: ['deterministic'],
            async chat(request) {
                llmRequests.push(request)
                if (state.targetExecuted) return { content: 'completed', toolCalls: [] }
                return responseFor(evalCase.scenario, request, variant, state, llmRequests.length)
            },
        },
        { defaultModel: 'deterministic' },
    )

    const progressDetectorFactory =
        variant === 'baseline'
            ? undefined
            : () =>
                  new SemanticProgressDetector({
                      softThreshold: 2,
                      hardThreshold: variant === 'guarded' ? 4 : null,
                  })
    const loop = new AgentLoopRuntime({
        sessions,
        systemPrompt,
        tools,
        llm,
        trace,
        contextManager,
        policy: { maxSteps: 20 },
        progressDetectorFactory,
    })
    const agent = agents.create({
        sessionId: session.id,
        model: 'progress-mock/deterministic',
        loop,
    })

    return {
        agent,
        trace,
        recordingTokenMeter,
        llmRequests,
        sessions,
        session,
        async dispose() {},
    }
}

function responseFor(scenario, request, variant, state, requestCount) {
    const reminded = request.system.includes('[Harness progress notice]')
    if (scenario === 'unrecoverable-stall') {
        return tool('empty_search', { query: 'permanently empty' }, requestCount)
    }
    if (scenario === 'exact-repeat-recovery') {
        if (reminded || (variant === 'baseline' && requestCount >= 6))
            return tool('target', {}, requestCount)
        return tool('empty_search', { query: 'same query' }, requestCount)
    }
    if (scenario === 'argument-churn-recovery') {
        if (reminded || (variant === 'baseline' && requestCount >= 6))
            return tool('target', {}, requestCount)
        const queries = ['Agent', 'agent', 'AgentRuntime', 'Agent', 'agent']
        return tool(
            'empty_search',
            { query: queries[Math.min(requestCount - 1, queries.length - 1)] },
            requestCount,
        )
    }
    if (scenario === 'legitimate-refinement') {
        if (state.refinementCount >= 3) return tool('target', {}, requestCount)
        return tool('refine_search', { query: `step-${state.refinementCount + 1}` }, requestCount)
    }
    if (scenario === 'state-change') {
        if (requestCount === 1 || requestCount === 3) return tool('read_state', {}, requestCount)
        if (requestCount === 2) return tool('change_state', {}, requestCount)
        return tool('target', {}, requestCount)
    }
    if (scenario === 'mixed-parallel-progress') {
        if (requestCount === 1) return tool('empty_search', { query: 'same' }, requestCount)
        if (requestCount === 2) {
            return {
                toolCalls: [
                    { id: 'empty-parallel', name: 'empty_search', arguments: { query: 'same' } },
                    { id: 'useful-parallel', name: 'useful_parallel', arguments: {} },
                ],
            }
        }
        return tool('target', {}, requestCount)
    }
    throw new Error(`unknown progress scenario: ${scenario}`)
}

function tool(name, arguments_ = {}, requestCount) {
    return {
        toolCalls: [{ id: `call-${name}-${requestCount}`, name, arguments: arguments_ }],
    }
}
