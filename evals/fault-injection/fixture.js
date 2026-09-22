import { AgentLoopRuntime } from '../../src/core/agent-loop-runtime.js'
import { AgentRuntime } from '../../src/core/agent-runtime.js'
import { ContextManager } from '../../src/core/context-manager.js'
import { LlmRuntime } from '../../src/core/llm-runtime.js'
import { SessionRuntime } from '../../src/core/session-runtime.js'
import { SystemPromptRuntime } from '../../src/core/system-prompt-runtime.js'
import { TokenMeter } from '../../src/core/token-meter.js'
import { ToolRuntime } from '../../src/core/tool-runtime.js'
import { ToolScheduler } from '../../src/core/tool-scheduler.js'
import { RecordingTokenMeter } from '../../src/eval/eval-metrics.js'
import { CapturingTraceRuntime } from '../../src/eval/eval-runner.js'
import { FaultInjector } from './fault-injector.js'

const MODEL = 'fault-injection/deterministic'

export async function createFaultInjectionFixture({ evalCase, limits = {} }) {
    const sessions = new SessionRuntime()
    const session = await sessions.create({ source: 'fault-injection-eval' })
    const systemPrompt = new SystemPromptRuntime()
    const tools = new ToolRuntime()
    const llm = new LlmRuntime()
    const agents = new AgentRuntime()
    const trace = new CapturingTraceRuntime()
    const recordingTokenMeter = new RecordingTokenMeter()
    const faultInjector = new FaultInjector(evalCase.faults)
    const abortController = new AbortController()
    const pendingLlmStarted = deferred()
    const parallelStartedGate = deferred()
    const fastReadFinished = deferred()
    const parallelGate = deferred()
    let parallelStarted = 0
    let sideEffectExecutionCount = 0
    let providerFailure = null
    let agentError = null

    registerCaseTools({
        evalCase,
        tools,
        faultInjector,
        parallelGate,
        onParallelToolStart() {
            parallelStarted += 1
            if (parallelStarted === 2) parallelStartedGate.resolve()
        },
        onSideEffect() {
            sideEffectExecutionCount += 1
        },
    })
    const executeTool = tools.execute.bind(tools)
    tools.execute = async (name, ...args) => {
        const result = await executeTool(name, ...args)
        if (name === 'fast_read') fastReadFinished.resolve()
        return result
    }

    const contextManager = new ContextManager({
        sessions,
        tokenMeter: new TokenMeter(),
        policy: evalCase.contextPolicy ?? {},
        ...(evalCase.name === 'context-overflow' ? { planner: { plan: () => null } } : {}),
    })
    const originalPrepare = contextManager.prepare.bind(contextManager)
    contextManager.prepare = async (...args) => {
        const action = takeFault(faultInjector, 'context.before_prepare')
        const prepared = await originalPrepare(...args)
        if (
            action === 'verify_hard_pressure' &&
            prepared.metadata.pressure.state !== 'hard_limit'
        ) {
            throw new Error('context-overflow case did not reach hard pressure')
        }
        return prepared
    }

    const scheduler = {
        execute(toolCalls, options) {
            const action = takeFault(faultInjector, 'scheduler.before_batch')
            if (action === 'throw_dispatch_error') {
                throw new Error('injected scheduler dispatch failure')
            }
            return new ToolScheduler({ tools }).execute(toolCalls, options)
        },
    }

    const requests = []
    let requestNumber = 0
    llm.register(
        'fault-injection',
        {
            models: ['deterministic'],
            async chat(request) {
                requestNumber += 1
                recordingTokenMeter.estimateRequest(request)
                requests.push({
                    messages: structuredClone(request.messages),
                    tools: structuredClone(request.tools),
                })

                const beforeAction = takeFault(faultInjector, 'llm.before_request')
                if (beforeAction === 'throw_provider_500') {
                    providerFailure = new Error('mock provider 500')
                    providerFailure.code = 'PROVIDER_500'
                    throw providerFailure
                }
                if (beforeAction === 'wait_for_external_cancel') {
                    pendingLlmStarted.resolve()
                    return waitForAbortAsError(request.signal)
                }

                let response = responseFor(evalCase.name, requestNumber)
                const afterAction = takeFault(faultInjector, 'llm.after_request')
                if (afterAction === 'invalid_tool_args') {
                    response = {
                        ...response,
                        toolCalls: [
                            toolCall('invalid-number-1', 'read_number', {
                                value: 'not-an-integer',
                            }),
                        ],
                    }
                } else if (afterAction === 'unknown_tool') {
                    response = {
                        ...response,
                        toolCalls: [toolCall('unknown-tool-1', 'definitely_missing_tool', {})],
                    }
                }
                return response
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
        policy: { ...limits },
        scheduler,
    })
    const rawAgent = agents.create({ sessionId: session.id, model: MODEL, loop })
    const agent = {
        async send(input) {
            const pending = rawAgent.send(input, {
                signal: abortController.signal,
            })
            if (evalCase.name === 'llm-pending-cancel') {
                await pendingLlmStarted.promise
                abortController.abort()
            }
            if (evalCase.name === 'parallel-cancel') {
                await Promise.all([parallelStartedGate.promise, fastReadFinished.promise])
                abortController.abort()
                parallelGate.resolve()
            }
            try {
                return await pending
            } catch (error) {
                agentError = {
                    name: error?.name ?? 'Error',
                    message: error?.message ?? String(error),
                }
                return undefined
            }
        },
    }

    return {
        agent,
        trace,
        recordingTokenMeter,
        inspectors: {
            session,
            sessions,
            requests,
            faultInjector,
            get agentError() {
                return agentError
            },
            get providerFailureCode() {
                return providerFailure?.code ?? null
            },
            get sideEffectExecutionCount() {
                return sideEffectExecutionCount
            },
            get parallelStarted() {
                return parallelStarted
            },
        },
        async dispose() {
            await sessions.dispose()
        },
    }
}

export function scoreFaultInjection({ trace, evalCase, fixture }) {
    const { session, faultInjector, agentError, providerFailureCode } = fixture.inspectors
    const events = session.events
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    const callCounts = countBy(calls.map((call) => call.id))
    const resultCounts = countBy(results.map((result) => result.data.toolCallId))
    const duplicateToolResultIds = [...resultCounts]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort()
    const unmatchedToolCallIds = [...callCounts]
        .filter(([id, count]) => count !== 1 || resultCounts.get(id) !== 1)
        .map(([id]) => id)
        .sort()
    const orphanToolResultIds = [...resultCounts]
        .filter(([id]) => !callCounts.has(id))
        .map(([id]) => id)
        .sort()
    let protocolComplete =
        duplicateToolResultIds.length === 0 &&
        unmatchedToolCallIds.length === 0 &&
        orphanToolResultIds.length === 0
    try {
        assertToolProtocolComplete(events)
    } catch {
        protocolComplete = false
    }
    const toolFailures = results.filter((event) => event.data.isError).length
    const cancelledToolResults = results.filter(
        (event) => event.data.errorCode === 'cancelled',
    ).length
    const injections = faultInjector.injections
    const actionDetail = getCaseDetails(evalCase.name, results, fixture)
    const scoreDetails = {
        faultPoint: [...new Set(injections.map((item) => item.point))].join(',') || null,
        injectedCount: faultInjector.injectedCount,
        faultInjections: injections,
        toolCallCount: calls.length,
        toolResultCount: results.length,
        duplicateToolResultIds,
        unmatchedToolCallIds,
        orphanToolResultIds,
        toolFailures,
        cancelledToolResults,
        sideEffectExecutionCount: fixture.inspectors.sideEffectExecutionCount,
        expectedStopReason: evalCase.expected.stopReason,
        stopReason: trace?.stopReason ?? null,
        protocolComplete,
        agentError,
        providerFailureCode,
        toolResultErrorCodes: results.map((event) => event.data.errorCode),
        toolErrorCodes: results
            .filter((event) => event.data.isError)
            .map((event) => event.data.errorCode),
        traceStepCount: trace?.steps?.length ?? 0,
        traceToolStatuses: (trace?.steps ?? []).flatMap((step) =>
            step.toolCalls.map((call) => call.status),
        ),
        eventTypes: events.map((event) => event.type),
        ...actionDetail,
    }
    const success =
        trace?.stopReason === evalCase.expected.stopReason &&
        protocolComplete &&
        actionDetail.caseInvariant === true
    return { success, details: scoreDetails }
}

export function assertToolProtocolComplete(events) {
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    const callCounts = countBy(calls.map((call) => call.id))
    const resultCounts = countBy(results.map((result) => result.data.toolCallId))
    const complete =
        [...callCounts].every(([id, count]) => count === 1 && resultCounts.get(id) === 1) &&
        [...resultCounts].every(([id, count]) => count === 1 && callCounts.get(id) === 1)
    if (!complete) throw new Error('Tool Call / Result protocol is incomplete or duplicated')
    return true
}

function registerCaseTools({
    evalCase,
    tools,
    faultInjector,
    parallelGate,
    onParallelToolStart,
    onSideEffect,
}) {
    const add = (definition, execute) => {
        const { name } = definition
        tools.register({
            parameters: { type: 'object' },
            readOnly: true,
            idempotent: true,
            concurrencySafe: false,
            sideEffect: false,
            ...definition,
            async execute(args, context) {
                const beforeAction = takeFault(faultInjector, 'tool.before_execute', { tool: name })
                if (beforeAction === 'throw_before_execute') {
                    throw new Error(`injected before-execute failure: ${name}`)
                }
                if (beforeAction === 'barrier_cancel') onParallelToolStart()
                if (beforeAction === 'await_runtime_timeout' && context.signal.aborted) {
                    throw new Error('timeout signal arrived before slow tool started')
                }

                const executeAction = takeFault(faultInjector, 'tool.execute', { tool: name })
                if (executeAction === 'throw_execution_error') {
                    throw new Error('injected tool failure')
                }

                const value = await execute(args, context, { beforeAction, parallelGate })
                const afterAction = takeFault(faultInjector, 'tool.after_execute', { tool: name })
                if (afterAction === 'throw_after_execute') {
                    throw new Error(`injected after-execute failure: ${name}`)
                }
                return value
            },
        })
    }

    switch (evalCase.name) {
        case 'tool-error-recovery':
        case 'tool-error-limit':
            add(
                { name: 'unstable_tool', description: 'A deterministic fault target.' },
                async () => 'recovered',
            )
            break
        case 'tool-timeout':
            add(
                {
                    name: 'slow_tool',
                    timeoutMs: 0,
                    description: 'Waits cooperatively for runtime timeout.',
                },
                async (_args, { signal }) => waitForAbort(signal).then(() => 'timeout settled'),
            )
            break
        case 'invalid-tool-args':
            add(
                {
                    name: 'read_number',
                    parameters: {
                        type: 'object',
                        properties: { value: { type: 'integer' } },
                        required: ['value'],
                        additionalProperties: false,
                    },
                },
                async ({ value }) => value,
            )
            break
        case 'parallel-cancel':
            add({ name: 'fast_read', concurrencySafe: true, readOnly: true }, async () => 'fast')
            for (const name of ['slow_read_a', 'slow_read_b']) {
                add(
                    { name, concurrencySafe: true, readOnly: true },
                    async (_args, _context, { parallelGate: gate }) =>
                        gate.promise.then(() => name),
                )
            }
            break
        case 'context-overflow':
            add({ name: 'large_result', readOnly: true }, async () => 'context growth '.repeat(800))
            break
        case 'post-commit-dispatch-failure':
            add({ name: 'dispatch_probe' }, async () => 'must not execute')
            break
        case 'side-effect-no-retry':
            add(
                {
                    name: 'side_effect_tool',
                    readOnly: false,
                    idempotent: false,
                    concurrencySafe: false,
                    sideEffect: true,
                },
                async () => {
                    onSideEffect()
                    return 'effect applied'
                },
            )
            break
        default:
            break
    }
}

function responseFor(caseName, requestNumber) {
    if (caseName === 'tool-error-recovery') {
        return requestNumber <= 2
            ? response([toolCall(`unstable-${requestNumber}`, 'unstable_tool', {})])
            : response()
    }
    if (caseName === 'tool-error-limit') {
        return response([toolCall(`unstable-${requestNumber}`, 'unstable_tool', {})])
    }
    if (caseName === 'tool-timeout') {
        return requestNumber === 1 ? response([toolCall('slow-1', 'slow_tool', {})]) : response()
    }
    if (caseName === 'invalid-tool-args') {
        return requestNumber === 1
            ? response([toolCall('number-1', 'read_number', { value: 1 })])
            : response()
    }
    if (caseName === 'unknown-tool') {
        return requestNumber === 1
            ? response([toolCall('unknown-tool-1', 'lookup', {})])
            : response()
    }
    if (caseName === 'parallel-cancel') {
        return response([
            toolCall('fast-1', 'fast_read', {}),
            toolCall('slow-a-1', 'slow_read_a', {}),
            toolCall('slow-b-1', 'slow_read_b', {}),
        ])
    }
    if (caseName === 'context-overflow') {
        return requestNumber === 1
            ? response([toolCall('large-result-1', 'large_result', {})])
            : response()
    }
    if (caseName === 'post-commit-dispatch-failure') {
        return response([toolCall('dispatch-1', 'dispatch_probe', {})])
    }
    if (caseName === 'side-effect-no-retry') {
        return requestNumber === 1
            ? response([toolCall('effect-1', 'side_effect_tool', {})])
            : response()
    }
    return response()
}

function response(toolCalls = []) {
    return { content: 'deterministic fault-injection response', toolCalls }
}

function toolCall(id, name, arguments_) {
    return { id, name, arguments: arguments_ }
}

function takeFault(faultInjector, point, context) {
    if (!faultInjector.shouldFail(point, context)) return null
    const action = faultInjector.matchedAction
    faultInjector.record(point, context)
    return action
}

function getCaseDetails(caseName, results, fixture) {
    const codes = results.map((event) => event.data.errorCode)
    const trace = fixture.trace.latest()
    switch (caseName) {
        case 'llm-provider-error':
            return {
                llmFailureSemantics: 'provider-500/internal_error',
                caseInvariant:
                    fixture.inspectors.providerFailureCode === 'PROVIDER_500' &&
                    trace?.steps.length === 1 &&
                    fixture.inspectors.requests.length === 1,
            }
        case 'llm-pending-cancel':
            return {
                llmFailureSemantics: 'external-cancel-while-pending',
                providerTimeoutPolicy: 'not_implemented',
                caseInvariant:
                    fixture.inspectors.agentError?.message.includes('cancelled') === true &&
                    trace?.steps.length === 1,
            }
        case 'tool-error-recovery':
            return {
                caseInvariant:
                    trace?.stopReason === 'completed' &&
                    codes.filter((code) => code === 'execution_error').length === 1 &&
                    fixture.inspectors.requests.length === 3,
            }
        case 'tool-error-limit':
            return {
                caseInvariant:
                    trace?.stopReason === 'tool_failure_limit' &&
                    codes.filter((code) => code === 'execution_error').length === 2,
            }
        case 'tool-timeout':
            return {
                timeoutErrorCode: codes.find((code) => code === 'timeout') ?? null,
                timeoutTraceStatus:
                    trace?.steps
                        .flatMap((step) => step.toolCalls)
                        .some((call) => call.status === 'timeout') ?? false,
                caseInvariant:
                    trace?.stopReason === 'completed' &&
                    codes.includes('timeout') &&
                    trace?.steps
                        .flatMap((step) => step.toolCalls)
                        .some((call) => call.status === 'timeout'),
            }
        case 'invalid-tool-args':
            return {
                caseInvariant:
                    trace?.stopReason === 'completed' && codes.includes('invalid_arguments'),
            }
        case 'unknown-tool':
            return {
                caseInvariant: trace?.stopReason === 'completed' && codes.includes('unknown_tool'),
            }
        case 'parallel-cancel':
            return {
                parallelStarted: fixture.inspectors.parallelStarted,
                caseInvariant:
                    trace?.stopReason === 'cancelled' &&
                    fixture.inspectors.parallelStarted === 2 &&
                    results.some((event) => event.data.errorCode === null) &&
                    codes.filter((code) => code === 'cancelled').length === 2,
            }
        case 'context-overflow':
            return {
                caseInvariant:
                    trace?.stopReason === 'context_overflow' &&
                    results.length === 1 &&
                    eventsHaveCompleteCommittedStep(fixture.inspectors.session.events) &&
                    !fixture.inspectors.session.events.some(
                        (event) => event.type === 'context/compaction',
                    ),
            }
        case 'post-commit-dispatch-failure':
            return {
                caseInvariant:
                    trace?.stopReason === 'internal_error' &&
                    trace?.steps
                        .flatMap((step) => step.toolCalls)
                        .some((call) => call.status === 'error') &&
                    results.length === 1 &&
                    results[0].data.outcome === 'not_executed' &&
                    results[0].data.skipReason === 'internal_error',
            }
        case 'side-effect-no-retry':
            return {
                caseInvariant:
                    trace?.stopReason === 'internal_error' &&
                    fixture.inspectors.sideEffectExecutionCount === 1 &&
                    fixture.inspectors.agentError?.message.includes('mock provider 500') === true,
            }
        default:
            return { caseInvariant: false }
    }
}

function eventsHaveCompleteCommittedStep(events) {
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    return calls.length > 0 && results.length === calls.length
}

function countBy(values) {
    const counts = new Map()
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    return counts
}

function deferred() {
    let resolve
    const promise = new Promise((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function waitForAbort(signal) {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
}

function waitForAbortAsError(signal) {
    if (signal?.aborted) return Promise.reject(new Error('LLM request cancelled'))
    return new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('LLM request cancelled')), {
            once: true,
        }),
    )
}
