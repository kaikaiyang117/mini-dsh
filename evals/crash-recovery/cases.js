export const CRASH_RECOVERY_CASES = Object.freeze([
    {
        name: 'crash-after-user-message',
        prompt: 'continue',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'crash-after-tool-call-commit',
        prompt: 'continue',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'crash-after-side-effect-start',
        prompt: 'continue',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'crash-after-tool-result-commit',
        prompt: 'continue',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
    {
        name: 'torn-tool-result-tail',
        prompt: 'continue',
        expected: { completion: 'stop-reason', stopReason: 'completed' },
    },
])
