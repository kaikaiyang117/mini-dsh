const BYTES_PER_TOKEN = 3

/**
 * Provider-neutral request estimator. This deliberately conservative heuristic
 * is a context-pressure guard, not billing or provider usage truth. A
 * model-specific tokenizer can be injected behind the same interface later.
 */
export class TokenMeter {
    estimateRequest({ model: _model, system, messages = [], tools = [] } = {}) {
        return {
            tokens: estimatePart(system) + estimatePart(messages) + estimatePart(tools),
            exact: false,
            method: 'heuristic-v1',
        }
    }
}

function estimatePart(value) {
    if (value === undefined || value === null || value === '') return 0
    if (Array.isArray(value) && value.length === 0) return 0
    const text = typeof value === 'string' ? value : JSON.stringify(stableValue(value))
    return text.length === 0 ? 0 : Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN)
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stableValue(value[key])]),
    )
}
