export const PROGRESS_CASES = Object.freeze([
    {
        name: 'exact-repeat-recovery',
        prompt: 'Find the requested item despite an empty search result.',
        expected: { completion: 'target-tool', targetTool: 'target' },
        scenario: 'exact-repeat-recovery',
    },
    {
        name: 'argument-churn-recovery',
        prompt: 'Search for the requested item using useful queries.',
        expected: { completion: 'target-tool', targetTool: 'target' },
        scenario: 'argument-churn-recovery',
    },
    {
        name: 'legitimate-refinement',
        prompt: 'Refine the search through new information.',
        expected: { completion: 'target-tool', targetTool: 'target' },
        scenario: 'legitimate-refinement',
    },
    {
        name: 'state-change',
        prompt: 'Read state, change it, and confirm the new value.',
        expected: { completion: 'target-tool', targetTool: 'target' },
        scenario: 'state-change',
    },
    {
        name: 'mixed-parallel-progress',
        prompt: 'Use parallel results to make progress.',
        expected: { completion: 'target-tool', targetTool: 'target' },
        scenario: 'mixed-parallel-progress',
    },
    {
        name: 'unrecoverable-stall',
        prompt: 'Stop repeated empty searches when no recovery is possible.',
        expected: {
            completion: 'stop-reason',
            stopReason: {
                baseline: 'step_limit',
                remind: 'step_limit',
                guarded: 'no_progress',
            },
        },
        scenario: 'unrecoverable-stall',
    },
])
