import dotenv from 'dotenv'
import { createCodingBenchmarkSuite } from '../../benchmarks/coding/suite.js'
import { pricingFromEnv } from '../core/cost-estimator.js'
import { writeJsonReport } from '../eval/eval-reporter.js'
import { parseBenchmarkArgs, selectBenchmarkMatrix } from './benchmark-config.js'
import { renderBenchmarkTable } from './benchmark-report.js'
import { BenchmarkRunner } from './benchmark-runner.js'

export async function runCodingBenchmarkCli(args = process.argv.slice(2), env = process.env) {
    dotenv.config()
    const config = parseBenchmarkArgs(
        args.filter((arg) => arg !== '--'),
        env,
    )
    const suite = createCodingBenchmarkSuite()
    const matrix = selectBenchmarkMatrix(suite, config)
    if (config.dryRun) {
        console.log(
            [
                `model: ${config.model}`,
                `cases: ${matrix.cases.length} (${matrix.cases.map(({ name }) => name).join(', ')})`,
                `variants: ${matrix.variants.join(', ')}`,
                `repeat: ${config.repetitions}`,
                `planned runs: ${matrix.plannedRuns}`,
                `output: ${config.output}`,
            ].join('\n'),
        )
        return null
    }

    const pricing = pricingFromEnv(env.MINI_DSH_PRICING_JSON)
    if (
        config.maxTotalCost !== null &&
        !config.allowUnknownCost &&
        config.model.startsWith('deepseek/') &&
        !pricing[config.model] &&
        !pricing.default
    ) {
        throw new Error(
            'max-total-cost requires known pricing; set MINI_DSH_PRICING_JSON or --allow-unknown-cost',
        )
    }
    if (config.model.startsWith('deepseek/') && !env.DEEPSEEK_API_KEY) {
        throw new Error('missing DEEPSEEK_API_KEY; set it before running a real benchmark')
    }
    const report = await new BenchmarkRunner({ suite, config }).run()
    await writeJsonReport(report, config.output)
    console.log(renderBenchmarkTable(report))
    console.log(`\nMachine-readable report: ${config.output}`)
    if (report.summary.budgetStopReason === 'unknown_cost') {
        throw new Error('benchmark stopped: sample cost is unknown under max-total-cost')
    }
    return report
}
