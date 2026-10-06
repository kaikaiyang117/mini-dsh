import { createCodingFixture, scoreCodingSmoke } from './fixture.js'
import { loadCodingCases } from './loader.js'
import { scoreCodingCase } from './scorer.js'
import { SMOKE_CASE } from './smoke-case.js'
import { createCodingCaseFixture } from './v1-fixture.js'

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

export function createCodingBenchmarkV1Suite(options = {}) {
    return {
        name: 'coding-benchmark',
        version: 1,
        cases: loadCodingCases(),
        variants: ['minimal', 'full'],
        fixtureFactory: (input) => createCodingCaseFixture({ ...input, ...options }),
        scorer: scoreCodingCase,
    }
}
