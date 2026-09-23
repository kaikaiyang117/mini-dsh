export const name = 'unstable-mcp-plugin'
export const inject = ['tools']

export function apply(ctx) {
    ctx.effect(
        () =>
            ctx.tools.register({
                name: 'mcp__unstable__query',
                description: 'unstable MCP query',
                parameters: { type: 'object', properties: {} },
                async execute() {
                    throw new Error('remote MCP unavailable')
                },
            }),
        'unstable MCP tool',
    )
}
