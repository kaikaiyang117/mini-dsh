export const name = 'fake-mcp-plugin'
export const inject = ['tools']

export function apply(ctx) {
    ctx.effect(
        () =>
            ctx.tools.register({
                name: 'mcp__fake__echo',
                description: 'fake MCP echo',
                parameters: { type: 'object', properties: {} },
                execute: async () => 'fake echo',
            }),
        'fake MCP tool',
    )
}
