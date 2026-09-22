import {
    DeterministicToolVisibility,
    normalizeMaxVisibleTools,
} from './deterministic-tool-visibility.js'
import { AllToolsVisibility } from './tool-visibility.js'

export const DEFAULT_TOOL_ROUTING = 'all'

export function toolVisibilityFromEnv(env = process.env) {
    const routing = String(env.MINI_DSH_TOOL_ROUTING ?? DEFAULT_TOOL_ROUTING)
        .trim()
        .toLowerCase()
    const maxVisibleTools = parseMaxVisibleTools(env.MINI_DSH_MAX_VISIBLE_TOOLS)

    if (routing === 'all') return new AllToolsVisibility()
    if (routing === 'deterministic') {
        return new DeterministicToolVisibility({ maxVisibleTools })
    }
    throw new TypeError('MINI_DSH_TOOL_ROUTING must be "all" or "deterministic"')
}

function parseMaxVisibleTools(value) {
    if (value === undefined || String(value).trim() === '') {
        return normalizeMaxVisibleTools(12)
    }
    const text = String(value).trim()
    if (!/^\d+$/.test(text)) {
        throw new TypeError('MINI_DSH_MAX_VISIBLE_TOOLS must be a positive integer')
    }
    return normalizeMaxVisibleTools(Number(text))
}
