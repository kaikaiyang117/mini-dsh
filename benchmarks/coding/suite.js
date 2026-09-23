import { createCodingFixture, scoreCodingSmoke } from './fixture.js'
import { SMOKE_CASE } from './smoke-case.js'

export function createCodingBenchmarkSuite(options = {}) {
    return {
        name: 'coding-smoke',
        version: 1,
        cases: [SMOKE_CASE],
        variants: ['minimal', 'full'],
        fixtureFactory: (input) => createCodingFixture({ ...input, ...options }),
        scorer: scoreCodingSmoke,
    }
}
