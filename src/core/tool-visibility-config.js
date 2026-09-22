import { DeterministicToolVisibility } from './deterministic-tool-visibility.js'
import { ProgressiveToolVisibility } from './progressive-tool-visibility.js'
import { DEFAULT_MAX_ACTIVATED_TOOLS, ToolActivationStore } from './tool-activation-store.js'
import { AllToolsVisibility } from './tool-visibility.js'

export const DEFAULT_TOOL_ROUTING = 'all'

export function createToolRoutingFromEnv(env = process.env) {
    const routing = String(env.MINI_DSH_TOOL_ROUTING ?? DEFAULT_TOOL_ROUTING)
        .trim()
        .toLowerCase()
    const maxVisibleTools = parsePositiveInteger(
        env.MINI_DSH_MAX_VISIBLE_TOOLS,
        12,
        'MINI_DSH_MAX_VISIBLE_TOOLS',
    )
    const maxActivatedTools = parsePositiveInteger(
        env.MINI_DSH_MAX_ACTIVATED_TOOLS,
        DEFAULT_MAX_ACTIVATED_TOOLS,
        'MINI_DSH_MAX_ACTIVATED_TOOLS',
    )

    if (routing === 'all') {
        return { mode: routing, visibility: new AllToolsVisibility(), activationStore: null }
    }

    const baseVisibility = new DeterministicToolVisibility({ maxVisibleTools })
    if (routing === 'deterministic') {
        return { mode: routing, visibility: baseVisibility, activationStore: null }
    }
    if (routing === 'progressive') {
        const activationStore = new ToolActivationStore({ maxActivatedTools })
        return {
            mode: routing,
            visibility: new ProgressiveToolVisibility({ baseVisibility, activationStore }),
            activationStore,
        }
    }
    throw new TypeError('MINI_DSH_TOOL_ROUTING must be "all", "deterministic", or "progressive"')
}

export function toolVisibilityFromEnv(env = process.env) {
    return createToolRoutingFromEnv(env).visibility
}

function parsePositiveInteger(value, fallback, name) {
    if (value === undefined || String(value).trim() === '') return fallback
    const text = String(value).trim()
    if (!/^\d+$/.test(text)) throw new TypeError(`${name} must be a positive integer`)
    const number = Number(text)
    if (!Number.isInteger(number) || number <= 0) {
        throw new TypeError(`${name} must be a positive integer`)
    }
    return number
}
