export const name = 'failing-mcp-plugin'
export const inject = ['tools']

export async function apply(ctx) {
    ctx.effect(
        () =>
            ctx.tools.register({
                name: 'mcp__broken__partial',
                description: 'partial registration',
                parameters: { type: 'object', properties: {} },
                execute: async () => 'unreachable',
            }),
        'partial MCP tool',
    )
    throw new Error('activation failed')
}
