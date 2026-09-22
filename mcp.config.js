export default [
    {
        name: 'context7',
        package: '@deepseek-ai/dsh-mcp-client',
        autoStart: true,
        config: {
            serverName: 'context7',
            transport: 'streamable-http',
            url: 'https://mcp.context7.com/mcp',
            headers: process.env.CONTEXT7_API_KEY
                ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` }
                : {},
            failOnStartupError: false,
            toolCallTimeoutMs: 60_000,
        },
    },
]
