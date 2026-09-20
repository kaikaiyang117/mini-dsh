import { randomUUID } from 'node:crypto'
import { RunController } from './run-controller.js'
import { combineAbortSignals, createRunDeadline } from './run-deadline.js'

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
    } = {}) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.llm = llm
        this.trace = trace
        this.policy = policy
        this.costEstimator = costEstimator
        this.controllerFactory = controllerFactory ?? ((options) => new RunController(options))
    }

    async run(
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
        let stopReason = 'internal_error'
        let lastContent = ''

        try {
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
                    const system = await this.systemPrompt.assemble({
                        agent,
                        sessionId,
                        step,
                    })
                    const messages = this.sessions.deriveMessages(sessionId)

                    let response
                    stepTrace?.startLlm()
                    try {
                        response = await this.llm.chat(
                            {
                                system,
                                messages,
                                tools: this.tools.schemas(),
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

                    let turnDecision = usageDecision.action === 'stop' ? usageDecision : null

                    for (const call of toolCalls) {
                        const toolTrace = stepTrace?.startToolCall(call)
                        const decision = turnDecision ?? controller.beforeToolCall(combinedSignal)

                        if (decision.action === 'stop') {
                            toolTrace?.finish(
                                decision.stopReason === 'cancelled'
                                    ? 'cancelled'
                                    : 'budget_exhausted',
                            )
                            await this.#appendSyntheticToolResult(
                                sessionId,
                                call,
                                runId,
                                stepId,
                                decision.stopReason,
                            )
                            turnDecision = decision
                            continue
                        }

                        onToolCall?.(call)
                        const result = await this.tools.execute(call.name, call.arguments, {
                            signal: combinedSignal,
                            sessionId,
                            toolCallId: call.id,
                            agent,
                        })
                        toolTrace?.finish(result.isError ? 'error' : 'completed')

                        const renderedContent = this.tools.renderResult(result)
                        onToolResult?.({
                            ...result,
                            renderedContent,
                            name: call.name,
                            toolCallId: call.id,
                        })

                        await this.sessions.append(sessionId, 'tool/result', {
                            toolCallId: call.id,
                            name: call.name,
                            isError: result.isError,
                            content: renderedContent,
                            runId,
                            stepId,
                        })

                        const resultDecision = controller.recordToolResult(result, combinedSignal)
                        if (resultDecision.action === 'stop') turnDecision = resultDecision
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
            deadline.dispose()
            await runTrace?.finish(stopReason)
            await onStop?.({ stopReason, state: controller.snapshot() })
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

    #estimateUsage(usage, model) {
        if (!this.costEstimator) return usage
        const slash = String(model ?? '').indexOf('/')
        const provider = slash > 0 ? String(model).slice(0, slash) : undefined
        const modelName = slash > 0 ? String(model).slice(slash + 1) : model
        return this.costEstimator.estimate(usage ?? {}, { provider, model: modelName })
    }
}
