export const DEFAULT_MAX_VISIBLE_TOOLS = 12
export const DEFAULT_MINIMUM_TOOL_SCORE = 1

export class DeterministicToolVisibility {
    constructor({
        maxVisibleTools = DEFAULT_MAX_VISIBLE_TOOLS,
        alwaysVisible = [],
        minimumScore = DEFAULT_MINIMUM_TOOL_SCORE,
    } = {}) {
        this.maxVisibleTools = normalizeMaxVisibleTools(maxVisibleTools)
        this.alwaysVisible = Object.freeze(normalizeAlwaysVisible(alwaysVisible))
        this.minimumScore = normalizeMinimumScore(minimumScore)
        Object.freeze(this)
    }

    select({ catalog, input } = {}) {
        if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array')
        const names = catalog.map((tool) => tool.name)
        if (catalog.length === 0) return []
        if (catalog.length <= this.maxVisibleTools) return names

        const queryTokens = tokenize(input)
        if (queryTokens.length === 0) return names

        const pinned = new Set(names.filter((name) => this.alwaysVisible.includes(name)))
        const query = queryTokens.join(' ')
        const scored = catalog
            .map((tool, index) => ({
                name: tool.name,
                index,
                score: scoreTool(tool, queryTokens, query),
            }))
            .filter(({ score }) => score >= this.minimumScore && score > 0)

        if (scored.length === 0) return names

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

function scoreTool(tool, queryTokens, normalizedQuery) {
    const nameTokens = tokenize(tool.name)
    const descriptionTokens = new Set(tokenize(tool.description))
    const parameterTokens = new Set(tokenize(propertyNames(tool.parameters)))
    const nameSet = new Set(nameTokens)

    let score = nameTokens.join(' ') === normalizedQuery ? 100 : 0
    for (const token of queryTokens) {
        if (nameSet.has(token)) score += 10
        if (descriptionTokens.has(token)) score += 3
        if (parameterTokens.has(token)) score += 1
    }
    return score
}

function tokenize(value) {
    return [
        ...new Set(
            String(value ?? '')
                .toLowerCase()
                .match(/[a-z0-9]+/g) ?? [],
        ),
    ]
}

function propertyNames(schema, names = []) {
    if (!schema || typeof schema !== 'object') return names
    if (Array.isArray(schema)) {
        for (const item of schema) propertyNames(item, names)
        return names
    }

    if (schema.properties && typeof schema.properties === 'object') {
        for (const [name, property] of Object.entries(schema.properties)) {
            names.push(name)
            propertyNames(property, names)
        }
    }
    for (const [key, value] of Object.entries(schema)) {
        if (key !== 'properties') propertyNames(value, names)
    }
    return names
}
