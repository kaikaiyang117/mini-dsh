export const MCP_FAILURE_CASES = Object.freeze([
    {
        name: 'activation-failure-cleanup',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'mixed-server-isolation',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'disconnect-removes-tools',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'reload-restores-tools',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'stale-schema-after-disconnect',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'active-plugin-tool-execution-failure',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'cleanup-failure-retry',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'reload-cleanup-failure',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'manager-dispose-partial-failure',
        prompt: 'run',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
])
