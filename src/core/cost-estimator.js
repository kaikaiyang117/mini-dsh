/**
 * Converts provider usage into standard usage with an optional estimated cost.
 * Pricing is supplied by the caller; this class has no provider-specific rates.
 */
export class CostEstimator {
    constructor({ pricing = {} } = {}) {
        this.pricing = pricing
    }

    estimate(usage = {}, { provider, model } = {}) {
        if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
            return { ...usage }
        }

        const price = this.#priceFor({ provider, model })
        const cost = price ? calculateCost(usage, price) : null
        return { ...usage, cost }
    }

    #priceFor({ provider, model }) {
        const selection = provider && model ? `${provider}/${model}` : model
        return this.pricing[selection] ?? this.pricing.default ?? null
    }
}

export function pricingFromEnv(value) {
    if (!value || !String(value).trim()) return {}
    try {
        const pricing = JSON.parse(value)
        if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
            throw new TypeError('pricing must be a JSON object')
        }
        return pricing
    } catch (error) {
        throw new TypeError(`MINI_DSH_PRICING_JSON must be valid JSON: ${error.message}`)
    }
}

function calculateCost(usage, price) {
    const input = number(usage.inputTokens)
    const output = number(usage.outputTokens)
    if (input === null || output === null) return null

    const inputRate = number(price.inputPer1k)
    const outputRate = number(price.outputPer1k)
    if (inputRate === null || outputRate === null) return null

    const cacheHit = number(usage.cacheHitTokens)
    const cacheMiss = number(usage.cacheMissTokens)
    const cacheHitRate = number(price.cacheHitPer1k)
    const cacheMissRate = number(price.cacheMissPer1k)
    const cacheCost =
        cacheHit !== null && cacheHitRate !== null
            ? (cacheHit * cacheHitRate) / 1000
            : cacheMiss !== null && cacheMissRate !== null
              ? (cacheMiss * cacheMissRate) / 1000
              : 0

    return (input * inputRate) / 1000 + (output * outputRate) / 1000 + cacheCost
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}
