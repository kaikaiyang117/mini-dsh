import { normalizeRunPolicy } from './run-controller.js'

export const DEFAULT_RUN_POLICY = Object.freeze({
    maxSteps: 32,
    maxToolCalls: 64,
    maxDurationMs: 10 * 60 * 1000,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxCost: null,
    maxToolFailures: 3,
})

const ENV_KEYS = {
    maxSteps: 'MINI_DSH_MAX_STEPS',
    maxToolCalls: 'MINI_DSH_MAX_TOOL_CALLS',
    maxDurationMs: 'MINI_DSH_MAX_DURATION_MS',
    maxInputTokens: 'MINI_DSH_MAX_INPUT_TOKENS',
    maxOutputTokens: 'MINI_DSH_MAX_OUTPUT_TOKENS',
    maxCost: 'MINI_DSH_MAX_COST',
    maxToolFailures: 'MINI_DSH_MAX_TOOL_FAILURES',
}

export function runPolicyFromEnv(env = process.env) {
    const raw = {}
    for (const [key, envKey] of Object.entries(ENV_KEYS)) {
        raw[key] = parsePolicyValue(env[envKey], DEFAULT_RUN_POLICY[key])
    }
    return normalizeRunPolicy(raw)
}

function parsePolicyValue(value, fallback) {
    if (value === undefined) return fallback
    const text = String(value).trim()
    if (text === '' || text.toLowerCase() === 'null') return null

    const number = Number(text)
    if (!Number.isFinite(number)) return value
    return number
}
