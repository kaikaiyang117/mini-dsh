import { TokenMeter } from '../core/token-meter.js'

export class RecordingTokenMeter {
    #tokenMeter
    #requests = []

    constructor({ tokenMeter = new TokenMeter() } = {}) {
        if (!tokenMeter || typeof tokenMeter.estimateRequest !== 'function') {
            throw new TypeError('RecordingTokenMeter requires estimateRequest()')
        }
        this.#tokenMeter = tokenMeter
    }

    estimateRequest(request) {
        const estimate = this.#tokenMeter.estimateRequest(request)
        const schemaEstimate = this.#tokenMeter.estimateRequest({ tools: request.tools ?? [] })
        this.#requests.push({
            visibleToolCount: (request.tools ?? []).length,
            toolSchemaTokens: schemaEstimate.tokens,
        })
        return estimate
    }

    get requests() {
        return structuredClone(this.#requests)
    }
}

export function summarizeEvalResults(results, variants) {
    return Object.fromEntries(
        variants.map((variant) => {
            const selected = results.filter((result) => result.variant === variant)
            const steps = sum(selected.map((result) => result.steps))
            const visibleTools = sum(selected.map((result) => result.visibleToolCount))
            const successes = selected.filter((result) => result.success).length
            const inputTokens = summarizeKnownUsage(selected, 'inputTokens')
            const outputTokens = summarizeKnownUsage(selected, 'outputTokens')
            const reasoningTokens = summarizeKnownUsage(selected, 'reasoningTokens')
            const cost = summarizeKnownUsage(selected, 'cost')

            return [
                variant,
                {
                    cases: selected.length,
                    successes,
                    successRate: selected.length === 0 ? null : successes / selected.length,
                    avgSteps: average(selected.map((result) => result.steps)),
                    avgToolCalls: average(selected.map((result) => result.toolCalls)),
                    avgVisibleTools: steps === 0 ? null : visibleTools / steps,
                    maxVisibleTools: max(selected.map((result) => result.maxVisibleToolCount)),
                    totalToolSchemaTokens: sum(selected.map((result) => result.toolSchemaTokens)),
                    avgToolSchemaTokens: average(selected.map((result) => result.toolSchemaTokens)),
                    totalInputTokens: inputTokens.total,
                    inputTokensAvailability: inputTokens.availability,
                    totalOutputTokens: outputTokens.total,
                    outputTokensAvailability: outputTokens.availability,
                    totalReasoningTokens: reasoningTokens.total,
                    reasoningTokensAvailability: reasoningTokens.availability,
                    totalCost: cost.total,
                    costAvailability: cost.availability,
                    avgDurationMs: average(selected.map((result) => result.durationMs)),
                },
            ]
        }),
    )
}

function summarizeKnownUsage(results, key) {
    const known = results
        .map((result) => result[key])
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
    return {
        total: known.length === 0 ? null : sum(known),
        availability: availability(known.length, results.length),
    }
}

function availability(known, total) {
    if (known === 0) return 'unavailable'
    if (known === total) return 'available'
    return 'partial'
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0)
}

function average(values) {
    if (values.length === 0) return null
    return sum(values) / values.length
}

function max(values) {
    return values.length === 0 ? 0 : Math.max(...values)
}
