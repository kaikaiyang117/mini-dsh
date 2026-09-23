import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import {
    createCodingFixture,
    scoreCodingSmoke,
    TEST_COMMAND,
} from '../benchmarks/coding/fixture.js'
import { createCodingBenchmarkSuite } from '../benchmarks/coding/suite.js'
import { runCodingBenchmarkCli } from '../src/benchmark/benchmark-cli.js'
import { parseBenchmarkArgs } from '../src/benchmark/benchmark-config.js'
import { BenchmarkRunner } from '../src/benchmark/benchmark-runner.js'

function fakeProvider({ cost = 0.4, calls, withToolError = false } = {}) {
    return async (root) => {
        let requestNumber = 0
        root.llm.register(
            'fake',
            {
                models: ['smoke'],
                async chat() {
                    const steps = [
                        ...(withToolError ? [['missing_tool', {}]] : []),
                        ['grep', { query: 'clamp' }],
                        ['read_file', { path: 'calculator.js' }],
                        ['read_file', { path: 'calculator.test.js' }],
                        ['bash', { command: TEST_COMMAND }],
                        [
                            'edit_file',
                            {
                                path: 'calculator.js',
                                oldText: 'return Math.min(min, Math.max(max, value))',
                                newText: 'return Math.max(min, Math.min(max, value))',
                            },
                        ],
                        ['bash', { command: TEST_COMMAND }],
                    ]
                    const next = steps[requestNumber]
                    requestNumber += 1
                    calls?.push(requestNumber)
                    return {
                        content: next ? '' : 'The local tests pass.',
                        reasoningContent: next ? 'PRIVATE_REASONING_SENTINEL' : undefined,
                        toolCalls: next
                            ? [{ id: `fake-${requestNumber}`, name: next[0], arguments: next[1] }]
                            : [],
                        usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1, cost },
                    }
                },
            },
            { defaultModel: 'smoke' },
        )
    }
}

function benchmark({
    repetitions = 1,
    variants = ['minimal'],
    selectedCases = [],
    maxTotalCost = null,
    allowUnknownCost = false,
    cost = 0.4,
    withToolError = false,
    fixtures,
    calls,
} = {}) {
    const registerProvider = fakeProvider({ cost, calls, withToolError })
    const suite = createCodingBenchmarkSuite({ registerProvider, pricing: {} })
    if (fixtures) {
        const originalFactory = suite.fixtureFactory
        suite.fixtureFactory = async (input) => {
            const fixture = await originalFactory(input)
            fixtures.push(fixture)
            return fixture
        }
    }
    const config = {
        model: 'fake/smoke',
        repetitions,
        variants,
        selectedCases,
        maxTotalCost,
        allowUnknownCost,
    }
    return new BenchmarkRunner({ suite, config }).run()
}

test('repeat creates independent samples, workspaces, sessions, traces and benchmark IDs', async () => {
    const fixtures = []
    const report = await benchmark({ repetitions: 3, variants: ['minimal', 'full'], fixtures })
    assert.equal(report.results.length, 6)
    assert.deepEqual(
        report.results.map((row) => row.repetition),
        [1, 2, 3, 1, 2, 3],
    )
    assert.equal(new Set(report.results.map((row) => row.runId)).size, 6)
    assert.equal(new Set(report.results.map((row) => row.agentRunId)).size, 6)
    assert.equal(new Set(fixtures.map((item) => item.inspectors.workspace)).size, 6)
    assert.equal(new Set(fixtures.map((item) => item.inspectors.session.id)).size, 6)
    assert.ok(fixtures.every((item) => !existsSync(item.inspectors.workspace)))
    assert.ok(
        report.results.every(
            (row) => row.success && row.provider === 'fake' && row.model === 'smoke',
        ),
    )
    assert.ok(report.results.every((row) => row.toolErrors === 0 && row.requestCount === 7))
    assert.equal(report.summary.variants.minimal.samples, 3)
    assert.equal(report.summary.variants.minimal.successes, 3)
    assert.equal(report.summary.variants.full.samples, 3)
    assert.equal(report.summary.variants.full.successes, 3)
    assert.equal(report.summary.variants.minimal.costAvailability, 'available')
    assert.ok(Math.abs(report.summary.totalKnownCost - 16.8) < 1e-9)
    assert.ok(report.results.every((row) => row.inputTokens === 70 && row.estimatedInputTokens > 0))
    assert.ok(
        report.results.every(
            (row) => row.scoreDetails.initialTestsFailed && row.scoreDetails.finalTestsPassed,
        ),
    )
    assert.ok(report.results.every((row) => row.scoreDetails.protocolComplete))
    assert.ok(!JSON.stringify(report).includes('PRIVATE_REASONING_SENTINEL'))
})

test('case and variant filters select only requested matrix entries', async () => {
    const report = await benchmark({ variants: ['full'], selectedCases: ['bugfix-single-file'] })
    assert.deepEqual(report.invocation.variants, ['full'])
    assert.deepEqual(report.invocation.selectedCases, ['bugfix-single-file'])
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0].variant, 'full')
    await assert.rejects(benchmark({ selectedCases: ['missing'] }), /unknown case/)
    await assert.rejects(benchmark({ variants: ['missing'] }), /unknown variant/)
})

test('CLI parses repeated and comma-separated filters and dry-run never contacts a provider', async () => {
    const parsed = parseBenchmarkArgs(
        [
            '--model',
            'fake/smoke',
            '--variant',
            'minimal',
            '--variants',
            'full,minimal',
            '--case',
            'bugfix-single-file',
            '--repeat',
            '3',
            '--max-total-cost',
            '1',
        ],
        {},
    )
    assert.deepEqual(parsed.variants, ['minimal', 'full'])
    assert.deepEqual(parsed.selectedCases, ['bugfix-single-file'])
    assert.equal(parsed.repetitions, 3)
    let output = ''
    const originalLog = console.log
    const originalFetch = globalThis.fetch
    console.log = (value) => {
        output += String(value)
    }
    globalThis.fetch = () => {
        throw new Error('dry-run contacted a provider')
    }
    try {
        const result = await runCodingBenchmarkCli(
            ['--dry-run', '--model', 'deepseek/deepseek-v4-pro', '--repeat', '3'],
            {},
        )
        assert.equal(result, null)
    } finally {
        console.log = originalLog
        globalThis.fetch = originalFetch
    }
    assert.match(output, /planned runs: 6/)
    assert.match(output, /model: deepseek\/deepseek-v4-pro/)
})

test('budget admits complete samples only and never treats unknown cost as zero', async () => {
    const known = await benchmark({
        repetitions: 3,
        variants: ['minimal', 'full'],
        maxTotalCost: 0.5,
    })
    assert.equal(known.summary.plannedRuns, 6)
    assert.equal(known.summary.startedRuns, 1)
    assert.equal(known.summary.completedRuns, 1)
    assert.equal(known.summary.skippedRuns, 5)
    assert.equal(known.summary.budgetStopped, true)
    assert.equal(known.summary.budgetStopReason, 'cost_limit')
    assert.ok(known.results[0].cost > 0.5)

    const unknown = await benchmark({ repetitions: 3, cost: null, maxTotalCost: 1 })
    assert.equal(unknown.results.length, 1)
    assert.equal(unknown.results[0].cost, null)
    assert.equal(unknown.summary.totalKnownCost, 0)
    assert.equal(unknown.summary.costAvailability, 'unavailable')
    assert.equal(unknown.summary.budgetStopReason, 'unknown_cost')

    const optedIn = await benchmark({
        repetitions: 3,
        cost: null,
        maxTotalCost: 1,
        allowUnknownCost: true,
    })
    assert.equal(optedIn.results.length, 3)
    assert.equal(optedIn.summary.costAvailability, 'unavailable')

    const zero = await benchmark({ maxTotalCost: 0 })
    assert.equal(zero.summary.startedRuns, 0)
    assert.equal(zero.summary.skippedRuns, 1)
    assert.equal(zero.summary.budgetStopReason, 'cost_limit')
})

test('toolErrors counts Session error results rather than guessing from Trace', async () => {
    const report = await benchmark({ withToolError: true })
    assert.equal(report.results[0].success, true)
    assert.equal(report.results[0].toolErrors, 1)
    assert.equal(report.summary.variants.minimal.avgToolErrors, 1)
})

test('smoke scorer rejects unexpected workspace changes despite passing tests', async () => {
    const suite = createCodingBenchmarkSuite({ registerProvider: fakeProvider() })
    const fixture = await createCodingFixture({
        variant: 'minimal',
        model: 'fake/smoke',
        registerProvider: fakeProvider(),
    })
    try {
        await fixture.agent.send(suite.cases[0].prompt)
        writeFileSync(`${fixture.inspectors.workspace}/unexpected.txt`, 'unexpected')
        const result = scoreCodingSmoke({ trace: fixture.trace.latest(), fixture })
        assert.equal(result.details.initialTestsFailed, true)
        assert.equal(result.details.finalTestsPassed, true)
        assert.deepEqual(result.details.unexpectedFiles, ['unexpected.txt'])
        assert.equal(result.success, false)
    } finally {
        await fixture.dispose()
    }
})

test('preflight rejects cost ceiling without DeepSeek pricing', async () => {
    await assert.rejects(
        runCodingBenchmarkCli(['--model', 'deepseek/deepseek-v4-pro', '--max-total-cost', '1'], {}),
        /requires known pricing/,
    )
})
