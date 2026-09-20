export const DEFAULT_CONTEXT_POLICY = Object.freeze({
    maxContextTokens: null,
    reservedOutputTokens: 0,
    compactAtRatio: 0.8,
})

export function normalizeContextPolicy(policy = {}) {
    const normalized = {
        maxContextTokens:
            policy.maxContextTokens === undefined
                ? DEFAULT_CONTEXT_POLICY.maxContextTokens
                : policy.maxContextTokens,
        reservedOutputTokens:
            policy.reservedOutputTokens === undefined
                ? DEFAULT_CONTEXT_POLICY.reservedOutputTokens
                : policy.reservedOutputTokens,
        compactAtRatio:
            policy.compactAtRatio === undefined
                ? DEFAULT_CONTEXT_POLICY.compactAtRatio
                : policy.compactAtRatio,
    }

    if (
        normalized.maxContextTokens !== null &&
        (!Number.isInteger(normalized.maxContextTokens) || normalized.maxContextTokens <= 0)
    ) {
        throw new TypeError('maxContextTokens must be null or a positive integer')
    }
    if (!Number.isInteger(normalized.reservedOutputTokens) || normalized.reservedOutputTokens < 0) {
        throw new TypeError('reservedOutputTokens must be a non-negative integer')
    }
    if (
        typeof normalized.compactAtRatio !== 'number' ||
        !Number.isFinite(normalized.compactAtRatio) ||
        normalized.compactAtRatio <= 0 ||
        normalized.compactAtRatio > 1
    ) {
        throw new TypeError('compactAtRatio must be greater than 0 and at most 1')
    }
    if (
        normalized.maxContextTokens !== null &&
        normalized.reservedOutputTokens >= normalized.maxContextTokens
    ) {
        throw new RangeError('reservedOutputTokens must be less than maxContextTokens')
    }
    return normalized
}

export function measureContextPressure(tokens, policy = {}) {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
        throw new TypeError('estimated tokens must be a non-negative finite number')
    }
    const normalized = normalizeContextPolicy(policy)
    if (normalized.maxContextTokens === null) {
        return {
            state: 'disabled',
            maxContextTokens: null,
            availableInputTokens: null,
            softLimitTokens: null,
        }
    }

    const availableInputTokens = normalized.maxContextTokens - normalized.reservedOutputTokens
    const softLimitTokens = availableInputTokens * normalized.compactAtRatio
    const state =
        tokens >= availableInputTokens
            ? 'hard_limit'
            : tokens >= softLimitTokens
              ? 'soft_limit'
              : 'normal'
    return {
        state,
        maxContextTokens: normalized.maxContextTokens,
        availableInputTokens,
        softLimitTokens,
    }
}
