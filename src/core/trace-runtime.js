import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const STOP_REASONS = Object.freeze([
    'completed',
    'cancelled',
    'step_limit',
    'tool_call_limit',
    'time_limit',
    'token_budget',
    'cost_budget',
    'tool_failure_limit',
    'context_overflow',
    'no_progress',
    'internal_error',
])

/**
 * Collects one structured trace for each Agent.send() run.
 *
 * Trace is an observability projection. It is deliberately separate from the
 * session event log, and persistence failures are warnings rather than run
 * failures.
 */
export class TraceRuntime {
    constructor({
        directory = '.trace',
        fileSystem = { mkdir, writeFile },
        createId = randomUUID,
        now = () => Date.now(),
        warn = (message) => console.warn(message),
    } = {}) {
        this.directory = directory
        this.fileSystem = fileSystem
        this.createId = createId
        this.now = now
        this.warn = warn
    }

    startRun({ sessionId, model } = {}) {
        const { provider, modelName } = splitModel(model)
        const startedAtMs = this.now()
        const trace = {
            runId: this.createId(),
            sessionId: sessionId ?? null,
            provider,
            model: modelName,
            startedAt: toIso(startedAtMs),
            endedAt: null,
            durationMs: null,
            stopReason: null,
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cost: 0,
            },
            steps: [],
        }

        let finished = false
        return {
            runId: trace.runId,
            trace,
            startStep: () => this.#startStep(trace),
            finish: async (stopReason) => {
                if (!finished) {
                    finished = true
                    trace.stopReason = normalizeStopReason(stopReason)
                    trace.endedAt = toIso(this.now())
                    trace.durationMs = Math.max(0, this.now() - startedAtMs)
                    await this.#persist(trace)
                }
                return trace
            },
        }
    }

    #startStep(trace) {
        const startedAtMs = this.now()
        const step = {
            stepId: this.createId(),
            startedAt: toIso(startedAtMs),
            endedAt: null,
            durationMs: null,
            llmLatencyMs: null,
            toolCalls: [],
        }
        trace.steps.push(step)

        let llmFinished = false
        let stepFinished = false

        return {
            stepId: step.stepId,
            finishLlm: (usage) => {
                if (llmFinished) return
                llmFinished = true
                step.llmLatencyMs = Math.max(0, this.now() - startedAtMs)
                addUsage(trace.usage, usage)
            },
            startToolCall: (call) => this.#startToolCall(step, call),
            finish: () => {
                if (stepFinished) return
                stepFinished = true
                if (!llmFinished) step.llmLatencyMs = Math.max(0, this.now() - startedAtMs)
                step.endedAt = toIso(this.now())
                step.durationMs = Math.max(0, this.now() - startedAtMs)
            },
        }
    }

    #startToolCall(step, call) {
        const startedAtMs = this.now()
        const toolCall = {
            toolCallId: call.id,
            name: call.name,
            startedAt: toIso(startedAtMs),
            endedAt: null,
            durationMs: null,
            status: 'running',
        }
        step.toolCalls.push(toolCall)

        let finished = false
        return {
            finish: (status) => {
                if (finished) return
                finished = true
                toolCall.status = status
                toolCall.endedAt = toIso(this.now())
                toolCall.durationMs = Math.max(0, this.now() - startedAtMs)
            },
        }
    }

    async #persist(trace) {
        try {
            await this.fileSystem.mkdir(this.directory, { recursive: true })
            await this.fileSystem.writeFile(
                path.join(this.directory, `${trace.runId}.json`),
                `${JSON.stringify(trace, null, 2)}\n`,
                'utf8',
            )
        } catch (error) {
            this.warn(`[TraceWarning] unable to persist ${trace.runId}: ${error?.message ?? error}`)
        }
    }
}

function splitModel(selection) {
    if (selection && typeof selection === 'object') {
        return {
            provider: selection.provider ?? null,
            modelName: selection.model ?? null,
        }
    }

    const text = String(selection ?? '')
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) {
        return { provider: null, modelName: text || null }
    }

    return {
        provider: text.slice(0, slash),
        modelName: text.slice(slash + 1),
    }
}

function addUsage(target, usage = {}) {
    target.inputTokens += numberFrom(usage.inputTokens, usage.promptTokens, usage.prompt_tokens)
    target.outputTokens += numberFrom(
        usage.outputTokens,
        usage.completionTokens,
        usage.completion_tokens,
    )
    target.reasoningTokens += numberFrom(usage.reasoningTokens, usage.reasoning_tokens)
    target.cost += numberFrom(usage.cost)
}

function numberFrom(...values) {
    const value = values.find((item) => item !== undefined && item !== null)
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeStopReason(reason) {
    return STOP_REASONS.includes(reason) ? reason : 'internal_error'
}

function toIso(timestamp) {
    return new Date(timestamp).toISOString()
}
