import { mkdir, writeFile } from 'node:fs/promises'
import { TOOL_ROUTING_CASES } from '../evals/tool-routing/cases.js'
import { createToolRoutingFixture } from '../evals/tool-routing/fixture.js'
import { EvalRunner } from '../src/eval/eval-runner.js'

const runner = new EvalRunner({
    cases: TOOL_ROUTING_CASES,
    fixtureFactory: createToolRoutingFixture,
})
const report = await runner.run()
const outputPath = '.eval/tool-routing.json'

await mkdir('.eval', { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('| variant | success | avg visible tools | schema tokens | avg steps |')
console.log('| --- | ---: | ---: | ---: | ---: |')
for (const [variant, summary] of Object.entries(report.variants)) {
    console.log(
        `| ${variant} | ${summary.successes}/${summary.cases} | ${format(summary.avgVisibleTools)} | ${summary.totalToolSchemaTokens} | ${format(summary.avgSteps)} |`,
    )
}
console.log(`\nMachine-readable report: ${outputPath}`)

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
