import { EvalSuite } from '../../src/eval/eval-suite.js'
import { LONG_HORIZON_CASES } from './cases.js'
import { createLongHorizonFixture, scoreLongHorizon } from './fixture.js'

const VARIANTS = ['baseline', 'managed']

export function createLongHorizonSuite() {
    return new EvalSuite({
        name: 'long-horizon-filesystem',
        cases: LONG_HORIZON_CASES,
        variants: VARIANTS,
        fixtureFactory: createLongHorizonFixture,
        scorer: scoreLongHorizon,
        assertions: [({ report }) => assertLongHorizonResults(report)],
        reporter: (report) => ({
            headers: [
                'variant',
                'success',
                'avg steps',
                'avg tool calls',
                'avg visible tools',
                'requests',
                'estimated input',
                'peak input/request',
                'avg duration ms',
                'stop reasons',
                'compactions',
            ],
            rows: VARIANTS.map((variant) => {
                const results = report.results.filter((result) => result.variant === variant)
                const summary = report.variants[variant]
                return [
                    variant,
                    `${summary.successes}/${summary.cases}`,
                    format(summary.avgSteps),
                    format(summary.avgToolCalls),
                    format(summary.avgVisibleTools),
                    summary.totalRequestCount,
                    summary.totalEstimatedInputTokens,
                    Math.max(...results.flatMap((result) => result.estimatedInputTokensByStep)),
                    format(summary.avgDurationMs),
                    [...new Set(results.map((result) => result.stopReason))].join(', '),
                    results.reduce(
                        (total, result) => total + result.scoreDetails.compactionCount,
                        0,
                    ),
                ]
            }),
        }),
    })
}

export function assertLongHorizonResults(report) {
    for (const result of report.results) {
        if (!result.success) {
            throw new Error(`${result.caseName}/${result.variant} must pass the workspace scorer`)
        }
        if (result.steps < 6 || result.steps > 12) {
            throw new Error(`${result.caseName}/${result.variant} must run 6 to 12 Agent Steps`)
        }
        for (const key of [
            'finalTestsPassed',
            'targetCorrect',
            'requiredReadsSatisfied',
            'requiredModificationsSatisfied',
            'noForbiddenFileChanges',
            'workspaceFilesOnly',
            'noWorkspaceExternalWrites',
            'bashStayedInWorkspace',
            'bashCommandsSafe',
            'protocolComplete',
        ]) {
            if (!result.scoreDetails[key]) {
                throw new Error(`${result.caseName}/${result.variant} failed ${key}`)
            }
        }
    }

    const result = (caseName, variant) =>
        report.results.find((entry) => entry.caseName === caseName && entry.variant === variant)
    const failedSearch = result('failed-first-search', 'managed')
    if (
        failedSearch.scoreDetails.toolFailures !== 0 ||
        failedSearch.scoreDetails.progressStops !== 0
    ) {
        throw new Error('a single empty search must not trigger a managed progress stop')
    }
    const editRecovery = result('failed-edit-recovery', 'managed')
    if (editRecovery.scoreDetails.toolFailures < 1) {
        throw new Error('failed-edit-recovery must exercise a real Tool Error before recovering')
    }
    const largeBaseline = result('large-context-fix', 'baseline')
    const largeManaged = result('large-context-fix', 'managed')
    if (
        largeManaged.scoreDetails.compactionCount < 1 ||
        largeManaged.stopReason !== 'completed' ||
        largeManaged.estimatedInputTokensByStep.length === 0 ||
        Math.max(...largeManaged.estimatedInputTokensByStep) >=
            Math.max(...largeBaseline.estimatedInputTokensByStep)
    ) {
        throw new Error('managed large-context case must compact, complete, and lower peak input')
    }
    const baseline = report.variants.baseline
    const managed = report.variants.managed
    if (managed.avgVisibleTools >= baseline.avgVisibleTools) {
        throw new Error('managed deterministic visibility must reduce visible Tool schemas')
    }
}

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
