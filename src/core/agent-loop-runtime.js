import { randomUUID } from 'node:crypto'
import { RunController } from './run-controller.js'

const CANCELLED_RESULT = 'ToolError: the run was cancelled before this tool ran'

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
        controllerFactory,
    } = {}) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.llm = llm
        this.trace = trace
        this.policy = policy
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
        } = {},
    ) {
        const sessionId = agent.sessionId
        const controller = this.controllerFactory({ policy, now })
        const runTrace = this.trace?.startRun({ sessionId, model: agent.model })
        const runId = runTrace?.runId ?? randomUUID()
        let stopReason = 'internal_error'
        let lastContent = ''

        try {
            await this.sessions.append(sessionId, 'user/message', { content: input, runId })
            let step = 0

            while (true) {
                const stepDecision = controller.beforeStep(signal)
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
                                signal,
                                onReasoning,
                                onContent,
                            },
                            agent.model,
                        )
                    } finally {
                        stepTrace?.finishLlm(response?.usage)
                    }

                    const usageDecision = controller.recordLlmUsage(response?.usage, signal)
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
                        const decision = turnDecision ?? controller.beforeToolCall(signal)

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
                            signal,
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

                        const resultDecision = controller.recordToolResult(result, signal)
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
            stopReason =
                signal?.aborted || /cancelled/i.test(error?.message ?? '')
                    ? 'cancelled'
                    : 'internal_error'
            throw error
        } finally {
            await runTrace?.finish(stopReason)
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
        const content =
            stopReason === 'cancelled'
                ? CANCELLED_RESULT
                : `Tool call was not executed because the run stopped (${stopReason}); actual outcome is unknown.`
        await this.sessions.append(sessionId, 'tool/result', {
            toolCallId: call.id,
            name: call.name,
            isError: true,
            content,
            outcome: 'unknown',
            recovered: true,
            retryable: false,
            budgetStop: stopReason !== 'cancelled',
            runId,
            stepId,
        })
    }
}
