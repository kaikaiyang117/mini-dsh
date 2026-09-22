export const DEFAULT_MAX_VISIBLE_TOOLS = 12

import { DEFAULT_MINIMUM_TOOL_SCORE, rankTools } from './tool-ranking.js'

export { DEFAULT_MINIMUM_TOOL_SCORE }

export class DeterministicToolVisibility {
    constructor({
        maxVisibleTools = DEFAULT_MAX_VISIBLE_TOOLS,
        alwaysVisible = [],
        minimumScore = DEFAULT_MINIMUM_TOOL_SCORE,
        noMatchFallback = 'all',
    } = {}) {
        this.maxVisibleTools = normalizeMaxVisibleTools(maxVisibleTools)
        this.alwaysVisible = Object.freeze(normalizeAlwaysVisible(alwaysVisible))
        this.minimumScore = normalizeMinimumScore(minimumScore)
        this.noMatchFallback = normalizeNoMatchFallback(noMatchFallback)
        Object.freeze(this)
    }

    select({ catalog, input } = {}) {
        if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array')
        const names = catalog.map((tool) => tool.name)
        if (catalog.length === 0) return []
        if (catalog.length <= this.maxVisibleTools) return names

        const pinned = new Set(names.filter((name) => this.alwaysVisible.includes(name)))
        const scored = rankTools(catalog, input, { minimumScore: this.minimumScore })

        if (scored.length === 0) {
            return this.noMatchFallback === 'all' ? names : [...pinned]
        }

        const ranked = scored
            .filter(({ name }) => !pinned.has(name))
            .sort((left, right) => right.score - left.score || left.index - right.index)

        return [...ranked.slice(0, this.maxVisibleTools).map(({ name }) => name), ...pinned]
    }
}

export function normalizeMaxVisibleTools(value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError('maxVisibleTools must be a positive integer')
    }
    return value
}

function normalizeAlwaysVisible(value) {
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
        throw new TypeError('alwaysVisible must be an array of tool names')
    }
    return [...new Set(value)]
}

function normalizeMinimumScore(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError('minimumScore must be a non-negative finite number')
    }
    return value
}

function normalizeNoMatchFallback(value) {
    if (value !== 'all' && value !== 'none') {
        throw new TypeError('noMatchFallback must be "all" or "none"')
    }
    return value
}
