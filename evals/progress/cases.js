export const PROGRESS_CASES = Object.freeze([
    {
        name: 'exact-repeat-recovery',
        prompt: 'Find the requested item despite an empty search result.',
        expected: { targetTool: 'target' },
        scenario: 'exact-repeat-recovery',
    },
    {
        name: 'argument-churn-recovery',
        prompt: 'Search for the requested item using useful queries.',
        expected: { targetTool: 'target' },
        scenario: 'argument-churn-recovery',
    },
    {
        name: 'legitimate-refinement',
        prompt: 'Refine the search through new information.',
        expected: { targetTool: 'target' },
        scenario: 'legitimate-refinement',
    },
    {
        name: 'state-change',
        prompt: 'Read state, change it, and confirm the new value.',
        expected: { targetTool: 'target' },
        scenario: 'state-change',
    },
    {
        name: 'mixed-parallel-progress',
        prompt: 'Use parallel results to make progress.',
        expected: { targetTool: 'target' },
        scenario: 'mixed-parallel-progress',
    },
])
