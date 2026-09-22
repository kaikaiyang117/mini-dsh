export const DEFAULT_MINIMUM_TOOL_SCORE = 1

export function rankTools(catalog, query, { minimumScore = DEFAULT_MINIMUM_TOOL_SCORE } = {}) {
    if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array')
    if (typeof minimumScore !== 'number' || !Number.isFinite(minimumScore) || minimumScore < 0) {
        throw new TypeError('minimumScore must be a non-negative finite number')
    }

    const queryTokens = tokenizeToolText(query)
    if (queryTokens.length === 0) return []
    const normalizedQuery = queryTokens.join(' ')

    return catalog
        .map((tool, index) => ({
            name: tool.name,
            score: scoreTool(tool, queryTokens, normalizedQuery),
            index,
        }))
        .filter(({ score }) => score >= minimumScore && score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
}

export function tokenizeToolText(value) {
    return [
        ...new Set(
            String(value ?? '')
                .toLowerCase()
                .match(/[a-z0-9]+/g) ?? [],
        ),
    ]
}

function scoreTool(tool, queryTokens, normalizedQuery) {
    const nameTokens = tokenizeToolText(tool.name)
    const descriptionTokens = new Set(tokenizeToolText(tool.description))
    const parameterTokens = new Set(tokenizeToolText(propertyNames(tool.parameters)))
    const nameSet = new Set(nameTokens)

    let score = nameTokens.join(' ') === normalizedQuery ? 100 : 0
    for (const token of queryTokens) {
        if (nameSet.has(token)) score += 10
        if (descriptionTokens.has(token)) score += 3
        if (parameterTokens.has(token)) score += 1
    }
    return score
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
