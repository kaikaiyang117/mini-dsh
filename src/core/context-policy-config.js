import { DEFAULT_CONTEXT_POLICY, normalizeContextPolicy } from './context-policy.js'

const DEFAULT_PRODUCTION_RESERVED_OUTPUT_TOKENS = 4096

const ENV_KEYS = {
    maxContextTokens: 'MINI_DSH_MAX_CONTEXT_TOKENS',
    reservedOutputTokens: 'MINI_DSH_RESERVED_OUTPUT_TOKENS',
    compactAtRatio: 'MINI_DSH_COMPACT_AT_RATIO',
}

export function contextPolicyFromEnv(env = process.env) {
    const maxContextTokens = parseMaxContextTokens(env[ENV_KEYS.maxContextTokens])
    const reservedOutputTokens = parseNumber(
        env[ENV_KEYS.reservedOutputTokens],
        maxContextTokens === null
            ? DEFAULT_CONTEXT_POLICY.reservedOutputTokens
            : DEFAULT_PRODUCTION_RESERVED_OUTPUT_TOKENS,
    )
    const compactAtRatio = parseNumber(
        env[ENV_KEYS.compactAtRatio],
        DEFAULT_CONTEXT_POLICY.compactAtRatio,
    )

    return normalizeContextPolicy({
        maxContextTokens,
        reservedOutputTokens,
        compactAtRatio,
    })
}

function parseMaxContextTokens(value) {
    if (value === undefined) return null
    const text = String(value).trim()
    if (text === '' || text.toLowerCase() === 'null') return null
    return finiteNumberOrOriginal(text, value)
}

function parseNumber(value, fallback) {
    if (value === undefined || String(value).trim() === '') return fallback
    return finiteNumberOrOriginal(String(value).trim(), value)
}

function finiteNumberOrOriginal(text, original) {
    const number = Number(text)
    return Number.isFinite(number) ? number : original
}
