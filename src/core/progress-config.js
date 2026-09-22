import { SemanticProgressDetector } from './semantic-progress-detector.js'

export const PROGRESS_MODES = Object.freeze(['off', 'remind', 'guarded'])

export function progressConfigFromEnv(env = process.env) {
    const mode = env.MINI_DSH_PROGRESS_MODE ?? 'off'
    if (!PROGRESS_MODES.includes(mode)) {
        throw new TypeError(`MINI_DSH_PROGRESS_MODE must be one of: ${PROGRESS_MODES.join(', ')}`)
    }

    const softThreshold = parsePositiveInteger(
        env.MINI_DSH_PROGRESS_SOFT_STEPS,
        3,
        'MINI_DSH_PROGRESS_SOFT_STEPS',
    )
    const rawHardThreshold = env.MINI_DSH_PROGRESS_HARD_STEPS
    const configuredHardThreshold = parsePositiveInteger(
        rawHardThreshold,
        6,
        'MINI_DSH_PROGRESS_HARD_STEPS',
    )

    if (configuredHardThreshold <= softThreshold) {
        throw new TypeError('MINI_DSH_PROGRESS_HARD_STEPS must be greater than soft steps')
    }

    return {
        mode,
        softThreshold,
        hardThreshold: mode === 'remind' ? null : configuredHardThreshold,
    }
}

export function progressDetectorFactory(config) {
    if (!config || config.mode === 'off') return undefined
    const hardThreshold = config.mode === 'remind' ? null : config.hardThreshold
    return () =>
        new SemanticProgressDetector({
            softThreshold: config.softThreshold,
            hardThreshold,
        })
}

function parsePositiveInteger(value, fallback, name) {
    if (value === undefined || String(value).trim() === '') return fallback
    const number = Number(value)
    if (!Number.isInteger(number) || number <= 0) {
        throw new TypeError(`${name} must be a positive integer`)
    }
    return number
}
