import { randomUUID } from 'node:crypto'
import { ContextManager } from './context-manager.js'
import { RunController } from './run-controller.js'
import { combineAbortSignals, createRunDeadline } from './run-deadline.js'
import { SessionRunCoordinator } from './session-run-coordinator.js'
import { ToolCatalog } from './tool-catalog.js'
import { ToolScheduler } from './tool-scheduler.js'
import { AllToolsVisibility } from './tool-visibility.js'

const NOT_EXECUTED_RESULT = 'ToolError: the tool was not executed because the run stopped'

/**
 * Runs model/tool execution while delegating all per-run policy decisions to
 * RunController. Session events remain the source of truth.
 */
export class AgentLoopRuntime {
    constructor({
        sessions,
        systemPrompt,
        tools,
        llm,
        trace,
        policy = {},
        costEstimator,
        controllerFactory,
        scheduler,
        maxParallelToolCalls,
        contextManager,
        tokenMeter,
        contextPolicy,
        runCoordinator,
        toolCatalog,
        toolVisibility,
        progressDetectorFactory,
    } = {}) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.toolCatalog = toolCatalog ?? new ToolCatalog({ tools })
        this.toolVisibility = toolVisibility ?? new AllToolsVisibility()
        this.llm = llm
        this.trace = trace
        this.policy = policy
        this.costEstimator = costEstimator
        this.contextManager =
            contextManager ?? new ContextManager({ sessions, tokenMeter, policy: contextPolicy })
        this.controllerFactory = controllerFactory ?? ((options) => new RunController(options))
        this.scheduler =
            scheduler ??
            new ToolScheduler({
                tools,
                maxParallelToolCalls,
            })
        this.runCoordinator = runCoordinator ?? new SessionRunCoordinator()
        this.progressDetectorFactory = progressDetectorFactory
    }

    run(agent, input, options = {}) {
        return this.runCoordinator.run(agent.sessionId, () => this.#runOnce(agent, input, options))
    }

    async #runOnce(
        agent,
        input,
        {
            signal,
            onReasoning,
            onContent,
            onToolCall,
            onToolResult,
            policy = this.policy,
            now,
            onStop,
        } = {},
    ) {
        const sessionId = agent.sessionId
        const controller = this.controllerFactory({ policy, now })
        const deadline = createRunDeadline(controller.policy.maxDurationMs)
        const combinedSignal = combineAbortSignals(signal, deadline.signal)
        const runTrace = this.trace?.startRun({ sessionId, model: agent.model })
        const runId = runTrace?.runId ?? randomUUID()
        let progressDetector
        try {
            progressDetector = this.progressDetectorFactory?.({ runId, sessionId, agent })
        } catch {
            // Progress detection is an optional, fail-open run-local heuristic.
        }
        let stopReason = 'internal_error'
        let lastContent = ''

        try {
            try {
                await this.toolVisibility.beginRun?.({ runId, sessionId, agent })
            } catch {
                // Run-local visibility setup cannot prevent Agent execution.
            }
            await this.sessions.append(sessionId, 'user/message', { content: input, runId })
            let step = 0

            while (true) {
                const stepDecision = controller.beforeStep(combinedSignal)
                if (stepDecision.action === 'stop') {
                    return this.#finishDecision(
                        stepDecision,
                        (reason) => {
                            stopReason = reason
                        },
                        lastContent,
                    )
                }

                step = stepDecision.state.steps
                const stepTrace = runTrace?.startStep()
                const stepId = stepTrace?.stepId ?? randomUUID()
                try {
                    let system = await this.systemPrompt.assemble({
                        agent,
                        sessionId,
                        step,
                    })
                    try {
                        const reminder = progressDetector?.takeReminder()
                        if (reminder) system = appendProgressReminder(system, reminder)
                    } catch {
                        // A reminder failure must not prevent the model request.
                    }
                    const catalogSnapshot = this.toolCatalog.snapshot()
                    const visibleNames = await this.toolVisibility.select({
                        catalog: catalogSnapshot.list(),
                        agent,
                        sessionId,
                        runId,
                        stepId,
                        step,
                        input,
                    })
                    const toolSchemas = catalogSnapshot.view(visibleNames).schemas()
                    const preparedContext = await this.contextManager.prepare(sessionId, {
                        agent,
                        runId,
                        stepId,
                        step,
                        model: agent.model,
                        system,
                        tools: toolSchemas,
                    })
                    const contextDecision = controller.recordContextPressure(
                        preparedContext.metadata.pressure,
                        combinedSignal,
                    )
                    if (contextDecision.action === 'stop') {
                        return this.#finishDecision(
                            contextDecision,
                            (reason) => {
                                stopReason = reason
                            },
                            lastContent,
                        )
                    }
                    const { messages } = preparedContext

                    let response
                    stepTrace?.startLlm()
                    try {
                        response = await this.llm.chat(
                            {
                                system,
                                messages,
                                tools: toolSchemas,
                                signal: combinedSignal,
                                onReasoning,
                                onContent,
                            },
                            agent.model,
                        )
                    } finally {
                        const usage = this.#estimateUsage(response?.usage, agent.model)
                        stepTrace?.finishLlm(usage)
                    }

                    const usage = this.#estimateUsage(response?.usage, agent.model)
                    const usageDecision = controller.recordLlmUsage(usage, combinedSignal)
                    const toolCalls = response.toolCalls ?? []
                    lastContent = response.content ?? lastContent

                    if (toolCalls.length === 0) {
                        const content = response.content ?? ''
                        await this.sessions.append(sessionId, 'assistant/message', {
                            content,
                            runId,
                            stepId,
                        })
                        if (usageDecision.action === 'stop') {
                            return this.#finishDecision(
                                usageDecision,
                                (reason) => {
                                    stopReason = reason
                                },
                                content,
                            )
                        }
                        stopReason = 'completed'
                        return content
                    }

                    await this.sessions.append(sessionId, 'assistant/tool_calls', {
                        content: response.content ?? null,
                        reasoningContent: response.reasoningContent,
                        toolCalls,
                        runId,
                        stepId,
                    })

                    const batchController = new AbortController()
                    const toolSignal = combineAbortSignals(combinedSignal, batchController.signal)
                    let turnDecision = null
                    const stopAdmission = (decision) => {
                        if (
                            !turnDecision ||
                            decision.stopReason === 'cancelled' ||
                            decision.stopReason === 'time_limit'
                        ) {
                            turnDecision = decision
                        }
                    }
                    const stopBatch = (decision) => {
                        stopAdmission(decision)
                        if (!batchController.signal.aborted) {
                            batchController.abort({ stopReason: turnDecision.stopReason })
                        }
                    }

                    if (usageDecision.action === 'stop') stopBatch(usageDecision)

                    const startedToolCalls = new Set()
                    const settledToolRecords = new Map()
                    let records
                    try {
                        records = await this.scheduler.execute(toolCalls, {
                            signal: toolSignal,
                            run: async (call, { index, signal: executionSignal }) => {
                                if (combinedSignal?.aborted) {
                                    const decision = controller.beforeToolCall(combinedSignal)
                                    stopBatch(decision)
                                    return notStartedRecord(index, call, decision.stopReason)
                                }
                                if (turnDecision) {
                                    return notStartedRecord(index, call, turnDecision.stopReason)
                                }

                                const decision = controller.beforeToolCall(combinedSignal)
                                if (decision.action === 'stop') {
                                    if (decision.stopReason === 'tool_call_limit') {
                                        stopAdmission(decision)
                                    } else {
                                        stopBatch(decision)
                                    }
                                    return notStartedRecord(index, call, decision.stopReason)
                                }

                                startedToolCalls.add(call.id)
                                const toolTrace = stepTrace?.startToolCall(call)
                                notifyObserver(onToolCall, call)
                                const result = await this.tools.execute(call.name, call.arguments, {
                                    signal: executionSignal,
                                    sessionId,
                                    runId,
                                    stepId,
                                    toolCallId: call.id,
                                    agent,
                                })
                                toolTrace?.finish(toolTraceStatus(result))

                                if (!turnDecision) {
                                    const resultDecision = controller.recordToolResult(
                                        result,
                                        combinedSignal,
                                    )
                                    if (resultDecision.action === 'stop') stopBatch(resultDecision)
                                }

                                const record = {
                                    index,
                                    call,
                                    state: 'settled',
                                    result,
                                    renderedContent: this.tools.renderResult(result),
                                }
                                settledToolRecords.set(call.id, record)
                                return record
                            },
                        })
                    } catch (error) {
                        const answered = new Set(
                            this.sessions
                                .get(sessionId)
                                .events.filter(
                                    (event) =>
                                        event.type === 'tool/result' &&
                                        event.data.runId === runId &&
                                        event.data.stepId === stepId,
                                )
                                .map((event) => event.data.toolCallId),
                        )
                        for (const call of toolCalls) {
                            if (answered.has(call.id)) continue
                            const record = settledToolRecords.get(call.id)
                            if (record) {
                                await this.sessions.append(sessionId, 'tool/result', {
                                    toolCallId: call.id,
                                    name: call.name,
                                    isError: record.result.isError,
                                    errorCode: record.result.errorCode,
                                    content: record.renderedContent,
                                    runId,
                                    stepId,
                                })
                            } else if (startedToolCalls.has(call.id)) {
                                await this.#appendUnknownToolResult(sessionId, call, runId, stepId)
                            } else {
                                stepTrace?.skipToolCall(call, 'error')
                                await this.#appendSyntheticToolResult(
                                    sessionId,
                                    call,
                                    runId,
                                    stepId,
                                    'internal_error',
                                )
                            }
                            answered.add(call.id)
                        }
                        throw error
                    }

                    if (combinedSignal?.aborted) {
                        stopBatch(controller.beforeToolCall(combinedSignal))
                    }

                    for (const [index, call] of toolCalls.entries()) {
                        const record = records[index]
                        if (record.state === 'not_started') {
                            const reason =
                                record.stopReason ?? turnDecision?.stopReason ?? 'cancelled'
                            stepTrace?.skipToolCall(call, skippedTraceStatus(reason))
                            await this.#appendSyntheticToolResult(
                                sessionId,
                                call,
                                runId,
                                stepId,
                                reason,
                            )
                            continue
                        }

                        const { result, renderedContent } = record
                        notifyObserver(onToolResult, {
                            ...result,
                            renderedContent,
                            name: call.name,
                            toolCallId: call.id,
                        })
                        await this.sessions.append(sessionId, 'tool/result', {
                            toolCallId: call.id,
                            name: call.name,
                            isError: result.isError,
                            errorCode: result.errorCode,
                            content: renderedContent,
                            runId,
                            stepId,
                        })
                    }

                    if (combinedSignal?.aborted) {
                        stopBatch(controller.beforeToolCall(combinedSignal))
                    }

                    if (!turnDecision && progressDetector) {
                        try {
                            const progress = progressDetector.observeStep({ toolCalls, records })
                            const progressDecision = controller.recordProgress(
                                progress,
                                combinedSignal,
                            )
                            if (progressDecision.action === 'stop') turnDecision = progressDecision
                        } catch {
                            // Progress detection is auxiliary and always fails open.
                        }
                    }

                    if (turnDecision) {
                        return this.#finishDecision(
                            turnDecision,
                            (reason) => {
                                stopReason = reason
                            },
                            lastContent,
                        )
                    }
                } finally {
                    stepTrace?.finish()
                }
            }
        } catch (error) {
            if (signal?.aborted) {
                stopReason = 'cancelled'
                throw new Error('Agent run cancelled', { cause: error })
            }
            if (deadline.signal?.aborted || combinedSignal?.reason?.stopReason === 'time_limit') {
                stopReason = 'time_limit'
                return lastContent
            }
            stopReason = /cancelled/i.test(error?.message ?? '') ? 'cancelled' : 'internal_error'
            throw error
        } finally {
            try {
                await this.toolVisibility.endRun?.({ runId, sessionId, agent })
            } catch {
                // Run-local visibility cleanup cannot change the Agent outcome.
            }
            deadline.dispose()
            const finalState = controller.snapshot()
            try {
                await runTrace?.finish(stopReason)
            } finally {
                // Lifecycle callbacks are observers. A callback failure must
                // never replace the run result or the original run error.
                try {
                    await onStop?.({ stopReason, state: finalState })
                } catch {
                    // Intentionally ignored to preserve Agent.send() outcome.
                }
            }
        }
    }

    #finishDecision(decision, setStopReason, content) {
        setStopReason(decision.stopReason)
        if (decision.stopReason === 'cancelled') {
            throw new Error('Agent run cancelled')
        }
        return content
    }

    async #appendSyntheticToolResult(sessionId, call, runId, stepId, stopReason) {
        await this.sessions.append(sessionId, 'tool/result', {
            toolCallId: call.id,
            name: call.name,
            isError: true,
            errorCode:
                stopReason === 'cancelled' || stopReason === 'time_limit' ? 'cancelled' : null,
            content: `${NOT_EXECUTED_RESULT} (${stopReason})`,
            outcome: 'not_executed',
            skipped: true,
            recovered: false,
            skipReason: stopReason,
            retryable: false,
            budgetStop: stopReason !== 'cancelled',
            runId,
            stepId,
        })
    }

    async #appendUnknownToolResult(sessionId, call, runId, stepId) {
        await this.sessions.append(sessionId, 'tool/result', {
            toolCallId: call.id,
            name: call.name,
            isError: true,
            errorCode: null,
            content:
                'ToolError: scheduler failed after Tool execution started; actual outcome is unknown',
            outcome: 'unknown',
            recovered: false,
            retryable: false,
            runId,
            stepId,
        })
    }

    #estimateUsage(usage, model) {
        if (!this.costEstimator) return usage
        const slash = String(model ?? '').indexOf('/')
        const provider = slash > 0 ? String(model).slice(0, slash) : undefined
        const modelName = slash > 0 ? String(model).slice(slash + 1) : model
        return this.costEstimator.estimate(usage ?? {}, { provider, model: modelName })
    }
}

function toolTraceStatus(result) {
    if (!result.isError) return 'completed'
    if (result.errorCode === 'timeout') return 'timeout'
    if (result.errorCode === 'cancelled') return 'cancelled'
    return 'error'
}

function notStartedRecord(index, call, stopReason) {
    return {
        index,
        call,
        state: 'not_started',
        stopReason,
    }
}

function skippedTraceStatus(stopReason) {
    return stopReason === 'cancelled' || stopReason === 'time_limit'
        ? 'cancelled'
        : 'budget_exhausted'
}

function notifyObserver(observer, value) {
    if (typeof observer !== 'function') return
    try {
        Promise.resolve(observer(value)).catch(() => {})
    } catch {
        // Observers cannot affect execution or durable protocol events.
    }
}

function appendProgressReminder(system, reminder) {
    return system ? `${system}\n\n${reminder}` : reminder
}
