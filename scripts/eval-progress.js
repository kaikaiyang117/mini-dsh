import { mkdir, writeFile } from 'node:fs/promises'
import { PROGRESS_CASES } from '../evals/progress/cases.js'
import { createProgressFixture } from '../evals/progress/fixture.js'
import { EvalRunner } from '../src/eval/eval-runner.js'

const variants = ['baseline', 'remind', 'guarded']
const report = await new EvalRunner({
    cases: PROGRESS_CASES,
    variants,
    fixtureFactory: createProgressFixture,
}).run()

assertProgressResults(report)

const outputPath = '.eval/progress.json'
await mkdir('.eval', { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(
    '| variant | success | avg steps | avg tool calls | estimated input/run | no-progress stops |',
)
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [variant, summary] of Object.entries(report.variants)) {
    console.log(
        `| ${variant} | ${summary.successes}/${summary.cases} | ${format(summary.avgSteps)} | ${format(summary.avgToolCalls)} | ${format(summary.avgEstimatedInputTokens)} | ${summary.noProgressStops} |`,
    )
}
console.log(`\nMachine-readable report: ${outputPath}`)

function assertProgressResults(result) {
    for (const [name, summary] of Object.entries(result.variants)) {
        if (summary.successes !== summary.cases) {
            throw new Error(`${name} must pass every deterministic progress Eval case`)
        }
    }

    for (const name of ['exact-repeat-recovery', 'argument-churn-recovery']) {
        const baseline = findResult(result, name, 'baseline')
        for (const variant of ['remind', 'guarded']) {
            if (findResult(result, name, variant).steps >= baseline.steps) {
                throw new Error(`${variant} must recover earlier than baseline for ${name}`)
            }
        }
    }

    for (const name of ['legitimate-refinement', 'state-change', 'mixed-parallel-progress']) {
        const guarded = findResult(result, name, 'guarded')
        if (!guarded.success || guarded.stopReason !== 'completed') {
            throw new Error(`guarded mode must not stop valid progress in ${name}`)
        }
    }

    const unrecoverableBaseline = findResult(result, 'unrecoverable-stall', 'baseline')
    const unrecoverableRemind = findResult(result, 'unrecoverable-stall', 'remind')
    const unrecoverableGuarded = findResult(result, 'unrecoverable-stall', 'guarded')
    if (
        unrecoverableBaseline.stopReason !== 'step_limit' ||
        unrecoverableRemind.stopReason !== 'step_limit' ||
        unrecoverableGuarded.stopReason !== 'no_progress'
    ) {
        throw new Error('unrecoverable-stall must stop at the expected policy for each variant')
    }
    for (const metric of ['steps', 'toolCalls', 'estimatedInputTokens']) {
        if (unrecoverableGuarded[metric] >= unrecoverableBaseline[metric]) {
            throw new Error(`guarded mode must reduce ${metric} for unrecoverable-stall`)
        }
    }
    if (
        result.variants.baseline.noProgressStops !== 0 ||
        result.variants.remind.noProgressStops !== 0 ||
        result.variants.guarded.noProgressStops < 1
    ) {
        throw new Error('only guarded mode should report no-progress stops in this Eval')
    }
}

function findResult(result, caseName, variant) {
    const match = result.results.find(
        (entry) => entry.caseName === caseName && entry.variant === variant,
    )
    if (!match) throw new Error(`missing Eval result for ${caseName}/${variant}`)
    return match
}

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
