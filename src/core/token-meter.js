const BYTES_PER_TOKEN = 4

/**
 * Provider-neutral request estimator. This is deliberately heuristic until a
 * model-specific tokenizer is injected behind the same interface.
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
