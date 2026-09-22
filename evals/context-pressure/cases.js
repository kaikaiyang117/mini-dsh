const EXPECTED_STOP_REASON = Object.freeze({
    'full-history': 'completed',
    constrained: 'context_overflow',
    compacted: 'completed',
})

export const CONTEXT_PRESSURE_CASES = Object.freeze([
    {
        name: 'long-history-pressure',
        prompt: 'GOAL_MARKER_CONTEXT_EVAL: inspect every requested chunk, then finish the task.',
        expected: { completion: 'stop-reason', stopReason: EXPECTED_STOP_REASON },
        scenario: 'long-history-pressure',
        metadata: { category: 'context-pressure' },
    },
    {
        name: 'recent-context-preservation',
        prompt: 'GOAL_MARKER_CONTEXT_EVAL: inspect the material and finish only when its current state is verified.',
        expected: { completion: 'stop-reason', stopReason: EXPECTED_STOP_REASON },
        scenario: 'recent-context-preservation',
        metadata: { category: 'context-preservation' },
    },
    {
        name: 'tool-protocol-pressure',
        prompt: 'GOAL_MARKER_CONTEXT_EVAL: inspect all paired tool results, then finish the task.',
        expected: { completion: 'stop-reason', stopReason: EXPECTED_STOP_REASON },
        scenario: 'tool-protocol-pressure',
        metadata: { category: 'tool-protocol' },
    },
])
