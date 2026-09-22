import { EvalSuite } from '../../src/eval/eval-suite.js'
import { PROGRESS_CASES } from './cases.js'
import { createProgressFixture } from './fixture.js'

const VARIANTS = ['baseline', 'remind', 'guarded']

export function createProgressSuite() {
    return new EvalSuite({
        name: 'progress',
        cases: PROGRESS_CASES,
        variants: VARIANTS,
        fixtureFactory: createProgressFixture,
        assertions: [({ report }) => assertProgressResults(report)],
        reporter: (report) => ({
            headers: [
                'variant',
                'success',
                'avg steps',
                'avg tool calls',
                'estimated input/run',
                'no-progress stops',
            ],
            rows: Object.entries(report.variants).map(([variant, summary]) => [
                variant,
                `${summary.successes}/${summary.cases}`,
                format(summary.avgSteps),
                format(summary.avgToolCalls),
                format(summary.avgEstimatedInputTokens),
                summary.noProgressStops,
            ]),
        }),
    })
}

function assertProgressResults(report) {
    for (const [name, summary] of Object.entries(report.variants)) {
        if (summary.successes !== summary.cases)
            throw new Error(`${name} must pass every deterministic progress Eval case`)
    }
    for (const name of ['exact-repeat-recovery', 'argument-churn-recovery']) {
        const baseline = findResult(report, name, 'baseline')
        for (const variant of ['remind', 'guarded']) {
            if (findResult(report, name, variant).steps >= baseline.steps)
                throw new Error(`${variant} must recover earlier than baseline for ${name}`)
        }
    }
    for (const name of ['legitimate-refinement', 'state-change', 'mixed-parallel-progress']) {
        const guarded = findResult(report, name, 'guarded')
        if (!guarded.success || guarded.stopReason !== 'completed')
            throw new Error(`guarded mode must not stop valid progress in ${name}`)
    }
    const baseline = findResult(report, 'unrecoverable-stall', 'baseline')
    const remind = findResult(report, 'unrecoverable-stall', 'remind')
    const guarded = findResult(report, 'unrecoverable-stall', 'guarded')
    if (
        baseline.stopReason !== 'step_limit' ||
        remind.stopReason !== 'step_limit' ||
        guarded.stopReason !== 'no_progress'
    ) {
        throw new Error('unrecoverable-stall must stop at the expected policy for each variant')
    }
    for (const metric of ['steps', 'toolCalls', 'estimatedInputTokens']) {
        if (guarded[metric] >= baseline[metric])
            throw new Error(`guarded mode must reduce ${metric} for unrecoverable-stall`)
    }
    if (
        report.variants.baseline.noProgressStops !== 0 ||
        report.variants.remind.noProgressStops !== 0 ||
        report.variants.guarded.noProgressStops < 1
    ) {
        throw new Error('only guarded mode should report no-progress stops in this Eval')
    }
}

function findResult(report, caseName, variant) {
    const result = report.results.find(
        (entry) => entry.caseName === caseName && entry.variant === variant,
    )
    if (!result) throw new Error(`missing Eval result for ${caseName}/${variant}`)
    return result
}

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
