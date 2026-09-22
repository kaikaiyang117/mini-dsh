export const STOP_REASONS = Object.freeze([
    'completed',
    'cancelled',
    'step_limit',
    'tool_call_limit',
    'time_limit',
    'input_token_limit',
    'output_token_limit',
    'cost_limit',
    'tool_failure_limit',
    'context_overflow',
    'no_progress',
    'internal_error',
])

const INTEGER_POLICY_KEYS = new Set([
    'maxSteps',
    'maxToolCalls',
    'maxInputTokens',
    'maxOutputTokens',
    'maxToolFailures',
])

const POLICY_KEYS = [
    'maxSteps',
    'maxToolCalls',
    'maxDurationMs',
    'maxInputTokens',
    'maxOutputTokens',
    'maxCost',
    'maxToolFailures',
]

/**
 * Per-run control state. It only makes control decisions; execution remains
 * in AgentLoopRuntime and durable facts remain in the Session Event Log.
 */
export class RunController {
    #policy
    #now
    #startedAt
    #steps = 0
    #toolCalls = 0
    #inputTokens = 0
    #outputTokens = 0
    #reasoningTokens = 0
    #toolFailures = 0
    #cost = 0
    #costKnown = true
    #hasUsage = false

    constructor({ policy = {}, now = () => Date.now() } = {}) {
        this.#policy = normalizeRunPolicy(policy)
        this.#now = now
        this.#startedAt = now()
    }

    get policy() {
        return { ...this.#policy }
    }

    beforeStep(signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        const duration = this.#durationDecision()
        if (duration) return duration

        const tokenLimit = this.#tokenDecision()
        if (tokenLimit) return tokenLimit

        if (this.#policy.maxSteps !== null && this.#steps >= this.#policy.maxSteps) {
            return this.#stop('step_limit')
        }

        this.#steps += 1
        return this.#continue()
    }

    recordLlmUsage(usage, signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        this.#hasUsage = true
        if (finite(usage?.inputTokens)) this.#inputTokens += usage.inputTokens
        if (finite(usage?.outputTokens)) this.#outputTokens += usage.outputTokens
        if (finite(usage?.reasoningTokens)) this.#reasoningTokens += usage.reasoningTokens

        if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) {
            if (this.#costKnown) this.#cost += usage.cost
        } else {
            this.#costKnown = false
        }

        return this.#limitDecision()
    }

    beforeToolCall(signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        const duration = this.#durationDecision()
        if (duration) return duration

        const tokenLimit = this.#tokenDecision()
        if (tokenLimit) return tokenLimit

        if (this.#policy.maxToolCalls !== null && this.#toolCalls >= this.#policy.maxToolCalls) {
            return this.#stop('tool_call_limit')
        }

        this.#toolCalls += 1
        return this.#continue()
    }

    recordToolResult(result, signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        if (result?.isError) this.#toolFailures += 1
        return this.#limitDecision()
    }

    recordProgress(progress, signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        const existingLimit = this.#limitDecision()
        if (existingLimit.action === 'stop') return existingLimit
        if (progress?.action === 'stop') return this.#stop('no_progress')
        return this.#continue()
    }

    recordContextPressure(pressure, signal) {
        const external = this.#externalDecision(signal)
        if (external) return external

        const duration = this.#durationDecision()
        if (duration) return duration

        return pressure?.state === 'hard_limit' ? this.#stop('context_overflow') : this.#continue()
    }

    snapshot() {
        return {
            steps: this.#steps,
            toolCalls: this.#toolCalls,
            inputTokens: this.#inputTokens,
            outputTokens: this.#outputTokens,
            reasoningTokens: this.#reasoningTokens,
            cost: this.#hasUsage && this.#costKnown ? this.#cost : null,
            toolFailures: this.#toolFailures,
            elapsedMs: Math.max(0, this.#now() - this.#startedAt),
        }
    }

    #limitDecision() {
        return (
            this.#durationDecision() ??
            this.#tokenDecision() ??
            this.#costDecision() ??
            this.#toolFailureDecision() ??
            this.#continue()
        )
    }

    #durationDecision() {
        if (
            this.#policy.maxDurationMs !== null &&
            this.#now() - this.#startedAt >= this.#policy.maxDurationMs
        ) {
            return this.#stop('time_limit')
        }
        return null
    }

    #tokenDecision() {
        if (
            this.#policy.maxInputTokens !== null &&
            this.#inputTokens >= this.#policy.maxInputTokens
        ) {
            return this.#stop('input_token_limit')
        }
        if (
            this.#policy.maxOutputTokens !== null &&
            this.#outputTokens >= this.#policy.maxOutputTokens
        ) {
            return this.#stop('output_token_limit')
        }
        return null
    }

    #costDecision() {
        if (
            this.#policy.maxCost !== null &&
            this.#hasUsage &&
            this.#costKnown &&
            this.#cost >= this.#policy.maxCost
        ) {
            return this.#stop('cost_limit')
        }
        return null
    }

    #toolFailureDecision() {
        if (
            this.#policy.maxToolFailures !== null &&
            this.#toolFailures >= this.#policy.maxToolFailures
        ) {
            return this.#stop('tool_failure_limit')
        }
        return null
    }

    #externalDecision(signal) {
        if (!signal?.aborted) return null
        return this.#stop(signal.reason?.stopReason === 'time_limit' ? 'time_limit' : 'cancelled')
    }

    #continue() {
        return {
            action: 'continue',
            stopReason: null,
            state: this.snapshot(),
        }
    }

    #stop(stopReason) {
        return {
            action: 'stop',
            stopReason,
            state: this.snapshot(),
        }
    }
}

export function normalizeRunPolicy(policy = {}) {
    const normalized = {}
    for (const key of POLICY_KEYS) {
        const value = policy[key]
        if (value === undefined || value === null) {
            normalized[key] = null
            continue
        }
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < 0 ||
            (INTEGER_POLICY_KEYS.has(key) && !Number.isInteger(value))
        ) {
            const kind = INTEGER_POLICY_KEYS.has(key)
                ? 'non-negative integer'
                : 'non-negative finite number'
            throw new TypeError(`${key} must be null or a ${kind}`)
        }
        normalized[key] = value
    }
    return normalized
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value)
}
