import { rankTools } from '../core/tool-ranking.js'

export const name = 'mini-tool-search'
export const inject = ['tools']
export const TOOL_SEARCH_NAME = 'tool_search'
export const DEFAULT_TOOL_SEARCH_LIMIT = 5
export const MAX_TOOL_SEARCH_LIMIT = 8
const MAX_DESCRIPTION_LENGTH = 160

export function apply(ctx, config = {}) {
    const { toolCatalog, activationStore } = config
    if (!toolCatalog || typeof toolCatalog.snapshot !== 'function') {
        throw new TypeError('tool_search requires toolCatalog.snapshot()')
    }
    if (!activationStore || typeof activationStore.activate !== 'function') {
        throw new TypeError('tool_search requires activationStore.activate()')
    }
    ctx.effect(
        () =>
            ctx.tools.register({
                name: TOOL_SEARCH_NAME,
                description:
                    'Search the full registered Tool catalog for capabilities that are not currently visible. Matching Tools are activated for later steps in the current Agent Run.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        limit: {
                            type: 'integer',
                            minimum: 1,
                            maximum: MAX_TOOL_SEARCH_LIMIT,
                        },
                    },
                    required: ['query'],
                    additionalProperties: false,
                },
                execute: async ({ query, limit = DEFAULT_TOOL_SEARCH_LIMIT }, execution) => {
                    const catalog = toolCatalog
                        .snapshot()
                        .list()
                        .filter((tool) => tool.name !== TOOL_SEARCH_NAME)
                    const matches = rankTools(catalog, query).slice(0, limit)
                    const activation = activationStore.activate(
                        execution.runId,
                        matches.map(({ name }) => name),
                    )

                    return {
                        query,
                        matches: matches.map(({ name }) => ({
                            name,
                            description: shortDescription(
                                catalog.find((tool) => tool.name === name)?.description,
                            ),
                        })),
                        activated: activation.activated,
                        alreadyActivated: activation.alreadyActivated,
                        notActivatedDueToLimit: activation.limitReached,
                        message: activation.limitReached.length ? 'activation limit reached' : null,
                    }
                },
            }),
        'tool search Tool',
    )
}

function shortDescription(description) {
    const text = String(description ?? '').trim()
    if (text.length <= MAX_DESCRIPTION_LENGTH) return text
    return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
}
