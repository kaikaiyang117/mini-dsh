import { EvalSuite } from '../../src/eval/eval-suite.js'
import { CONTEXT_PRESSURE_CASES } from './cases.js'
import { createContextPressureFixture, scoreContextPressure } from './fixture.js'

const VARIANTS = ['full-history', 'constrained', 'compacted']

export function createContextPressureSuite() {
    return new EvalSuite({
        name: 'context-pressure',
        cases: CONTEXT_PRESSURE_CASES,
        variants: VARIANTS,
        fixtureFactory: createContextPressureFixture,
        scorer: scoreContextPressure,
        assertions: [({ report }) => assertContextPressureResults(report)],
        reporter: (report) => ({
            headers: [
                'variant',
                'success',
                'avg steps',
                'requests',
                'peak input/request',
                'estimated input/run',
                'compactions',
            ],
            rows: VARIANTS.map((variant) => {
                const results = report.results.filter((result) => result.variant === variant)
                const summary = report.variants[variant]
                return [
                    variant,
                    `${summary.successes}/${summary.cases}`,
                    format(summary.avgSteps),
                    summary.totalRequestCount,
                    Math.max(...results.flatMap((result) => result.estimatedInputTokensByStep)),
                    format(summary.avgEstimatedInputTokens),
                    results.reduce(
                        (total, result) => total + result.scoreDetails.compactionCount,
                        0,
                    ),
                ]
            }),
        }),
    })
}

export function assertContextPressureResults(report) {
    for (const variant of VARIANTS) {
        const summary = report.variants[variant]
        if (summary.successes !== summary.cases) {
            throw new Error(`${variant} must satisfy every context-pressure expectation`)
        }
    }

    const result = (caseName, variant) =>
        report.results.find((entry) => entry.caseName === caseName && entry.variant === variant)
    const longFull = result('long-history-pressure', 'full-history')
    const longConstrained = result('long-history-pressure', 'constrained')
    const longCompacted = result('long-history-pressure', 'compacted')
    if (
        longConstrained.stopReason !== 'context_overflow' ||
        longConstrained.scoreDetails.finishSucceeded
    ) {
        throw new Error('constrained long-history baseline must overflow before finish_task')
    }
    if (
        peakRequestTokens(longCompacted) >= peakRequestTokens(longFull) ||
        longCompacted.estimatedInputTokens >= longFull.estimatedInputTokens
    ) {
        throw new Error('compaction must reduce long-history peak and cumulative estimated input')
    }

    for (const entry of report.results) {
        if (entry.requestCount !== entry.scoreDetails.modelRequestCount) {
            throw new Error('Eval request metrics must count only actual llm.chat() requests')
        }
        if (entry.variant === 'compacted' && entry.scoreDetails.compactionCount < 1) {
            throw new Error(`${entry.caseName} must compact at least once in compacted mode`)
        }
    }

    const recent = result('recent-context-preservation', 'compacted')
    if (!recent.scoreDetails.recentContextPreserved) {
        throw new Error('compaction must retain all required recent continuation markers')
    }
    const protocol = result('tool-protocol-pressure', 'compacted')
    if (
        !protocol.scoreDetails.protocolComplete ||
        !protocol.scoreDetails.protocolBoundarySafe ||
        !protocol.scoreDetails.originalEventsPreserved
    ) {
        throw new Error(
            'compaction must preserve durable events and complete Tool protocol boundaries',
        )
    }
    if (!protocol.scoreDetails.summarySafetyPreserved) {
        throw new Error('compaction summary must remain assistant historical context')
    }
}

function peakRequestTokens(result) {
    return Math.max(...result.estimatedInputTokensByStep)
}

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
