import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { STOP_REASONS } from './run-controller.js'

export { STOP_REASONS }

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
                inputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                cacheHitTokens: null,
                cacheMissTokens: null,
                cost: null,
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
                    const endedAtMs = this.now()
                    trace.endedAt = toIso(endedAtMs)
                    trace.durationMs = Math.max(0, endedAtMs - startedAtMs)
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
        let llmStartedAtMs = null

        return {
            stepId: step.stepId,
            startLlm: () => {
                llmStartedAtMs ??= this.now()
            },
            finishLlm: (usage) => {
                if (llmFinished) return
                llmFinished = true
                const endedAtMs = this.now()
                step.llmLatencyMs =
                    llmStartedAtMs === null ? null : Math.max(0, endedAtMs - llmStartedAtMs)
                addUsage(trace.usage, usage)
            },
            startToolCall: (call) => this.#startToolCall(step, call),
            skipToolCall: (call, status) => this.#skipToolCall(step, call, status),
            finish: () => {
                if (stepFinished) return
                stepFinished = true
                const endedAtMs = this.now()
                step.endedAt = toIso(endedAtMs)
                step.durationMs = Math.max(0, endedAtMs - startedAtMs)
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
                const endedAtMs = this.now()
                toolCall.endedAt = toIso(endedAtMs)
                toolCall.durationMs = Math.max(0, endedAtMs - startedAtMs)
            },
        }
    }

    #skipToolCall(step, call, status) {
        step.toolCalls.push({
            toolCallId: call.id,
            name: call.name,
            startedAt: null,
            endedAt: null,
            durationMs: null,
            status,
        })
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
    addUsageValue(
        target,
        'inputTokens',
        numberFrom(usage.inputTokens, usage.promptTokens, usage.prompt_tokens),
    )
    addUsageValue(
        target,
        'outputTokens',
        numberFrom(usage.outputTokens, usage.completionTokens, usage.completion_tokens),
    )
    addUsageValue(
        target,
        'reasoningTokens',
        numberFrom(usage.reasoningTokens, usage.reasoning_tokens),
    )
    addUsageValue(target, 'cacheHitTokens', numberFrom(usage.cacheHitTokens))
    addUsageValue(target, 'cacheMissTokens', numberFrom(usage.cacheMissTokens))
    addUsageValue(target, 'cost', numberFrom(usage.cost))
}

function numberFrom(...values) {
    const value = values.find((item) => item !== undefined && item !== null)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function addUsageValue(target, key, value) {
    if (value !== null) target[key] = (target[key] ?? 0) + value
}

function normalizeStopReason(reason) {
    return STOP_REASONS.includes(reason) ? reason : 'internal_error'
}

function toIso(timestamp) {
    return new Date(timestamp).toISOString()
}
