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
