import { randomUUID } from 'node:crypto'
import { EvalRunner } from '../eval/eval-runner.js'
import { selectBenchmarkMatrix } from './benchmark-config.js'
import { gitCommit, summarizeBenchmark } from './benchmark-report.js'

export class BenchmarkRunner {
    constructor({
        suite,
        config,
        createId = randomUUID,
        now = () => new Date().toISOString(),
    } = {}) {
        if (!suite || !config) throw new TypeError('BenchmarkRunner requires suite and config')
        this.suite = suite
        this.config = config
        this.createId = createId
        this.now = now
    }

    async run() {
        const { suite, config } = this
        const matrix = selectBenchmarkMatrix(suite, config)
        const startedAt = this.now()
        const results = []
        const runIds = new Set()
        let knownCost = 0
        let budgetStopReason = null

        for (const evalCase of matrix.cases) {
            for (const variant of matrix.variants) {
                for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
                    if (config.maxTotalCost !== null && knownCost >= config.maxTotalCost) {
                        budgetStopReason = 'cost_limit'
                        break
                    }
                    let toolErrors = 0
                    let agentRunId = null
                    const sampleCase = {
                        ...evalCase,
                        scorer: (input) => {
                            agentRunId = input.trace?.runId ?? null
                            toolErrors = input.fixture.inspectors.session.events.filter(
                                (event) =>
                                    event.type === 'tool/result' && event.data.isError === true,
                            ).length
                            return (evalCase.scorer ?? suite.scorer)(input)
                        },
                    }
                    const report = await new EvalRunner({
                        suiteName: suite.name,
                        cases: [sampleCase],
                        variants: [variant],
                        fixtureFactory: (input) =>
                            suite.fixtureFactory({ ...input, model: config.model }),
                        scorer: suite.scorer,
                    }).run()
                    const row = report.results[0]
                    const [provider, model] = splitModel(config.model)
                    const runId = this.createId()
                    if (runIds.has(runId)) throw new Error(`duplicate benchmark runId: ${runId}`)
                    runIds.add(runId)
                    results.push({
                        benchmarkName: suite.name,
                        benchmarkVersion: suite.version,
                        runId,
                        agentRunId,
                        caseName: row.caseName,
                        variant,
                        repetition,
                        provider,
                        model,
                        success: row.success,
                        stopReason: row.stopReason,
                        steps: row.steps,
                        toolCalls: row.toolCalls,
                        toolErrors,
                        requestCount: row.requestCount,
                        inputTokens: row.inputTokens,
                        outputTokens: row.outputTokens,
                        reasoningTokens: row.reasoningTokens,
                        cost: row.cost,
                        estimatedInputTokens: row.estimatedInputTokens,
                        toolSchemaTokens: row.toolSchemaTokens,
                        visibleToolCount: row.visibleToolCount,
                        durationMs: row.durationMs,
                        scoreDetails: safeScoreDetails(row.scoreDetails),
                        error: row.error,
                    })
                    if (typeof row.cost === 'number' && Number.isFinite(row.cost)) {
                        knownCost += row.cost
                    } else if (config.maxTotalCost !== null && !config.allowUnknownCost) {
                        budgetStopReason = 'unknown_cost'
                        break
                    }
                }
                if (budgetStopReason) break
            }
            if (budgetStopReason) break
        }

        const report = {
            schemaVersion: 1,
            benchmark: { name: suite.name, version: suite.version },
            invocation: {
                provider: splitModel(config.model)[0],
                model: splitModel(config.model)[1],
                variants: matrix.variants,
                repetitions: config.repetitions,
                selectedCases: matrix.cases.map(({ name }) => name),
                maxTotalCost: config.maxTotalCost,
                allowUnknownCost: config.allowUnknownCost,
            },
            environment: {
                gitCommit: gitCommit(),
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
            },
            startedAt,
            finishedAt: this.now(),
            results,
            summary: summarizeBenchmark(
                results,
                matrix.variants,
                matrix.plannedRuns,
                budgetStopReason !== null,
            ),
        }
        report.summary.budgetStopReason = budgetStopReason
        return report
    }
}

function splitModel(selection) {
    const at = selection.indexOf('/')
    return [selection.slice(0, at), selection.slice(at + 1)]
}

function safeScoreDetails(details) {
    if (!details || typeof details !== 'object') return null
    return Object.fromEntries(
        [
            'filesRead',
            'filesModified',
            'unexpectedFiles',
            'initialTestsFailed',
            'finalTestsPassed',
            'protocolComplete',
        ].map((key) => [key, details[key] ?? null]),
    )
}
