import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PROGRESS_CASES } from '../evals/progress/cases.js'
import { createProgressFixture } from '../evals/progress/fixture.js'
import { TOOL_ROUTING_CASES } from '../evals/tool-routing/cases.js'
import { createToolRoutingFixture } from '../evals/tool-routing/fixture.js'
import { RecordingTokenMeter } from '../src/eval/eval-metrics.js'
import { renderMarkdownTable, writeJsonReport } from '../src/eval/eval-reporter.js'
import { EvalRunner, normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { EvalSuite, runEvalSuite } from '../src/eval/eval-suite.js'

const validCase = {
    name: 'one',
    prompt: 'run',
    expected: { completion: 'target-tool', targetTool: 'target' },
}

test('EvalSuite validates its identity, cases, variants, and factories', () => {
    assert.throws(() => new EvalSuite({}), /name/)
    assert.throws(
        () => new EvalSuite({ name: 'suite', cases: [{}], variants: ['v'], fixtureFactory() {} }),
        /invalid EvalCase/,
    )
    assert.throws(
        () =>
            new EvalSuite({
                name: 'suite',
                cases: [validCase],
                variants: ['v', 'v'],
                fixtureFactory() {},
            }),
        /unique non-empty strings/,
    )
    assert.throws(
        () =>
            new EvalSuite({
                name: 'suite',
                cases: [validCase],
                variants: ['v'],
                fixtureFactory() {},
                assertions: [true],
            }),
        /assertions/,
    )
})

test('EvalCase validation covers completion and limits contracts', () => {
    const make = (evalCase) =>
        new EvalSuite({ name: 'suite', cases: [evalCase], variants: ['v'], fixtureFactory() {} })
    assert.doesNotThrow(() => make(validCase))
    assert.doesNotThrow(() => make({ ...validCase, limits: { maxSteps: 3, maxInputTokens: 100 } }))
    assert.throws(() => make({ ...validCase, limits: { mystery: 1 } }), /invalid EvalCase/)
    assert.throws(
        () => make({ ...validCase, expected: { completion: 'stop-reason' } }),
        /invalid EvalCase/,
    )
    assert.throws(() => make({ ...validCase, limits: { maxSteps: 1.5 } }), /invalid EvalCase/)
    assert.throws(
        () => make({ ...validCase, limits: { maxToolCalls: Number.NaN } }),
        /invalid EvalCase/,
    )
    assert.doesNotThrow(() => make({ ...validCase, limits: { maxCost: 1.5 } }))
    assert.doesNotThrow(() => make({ ...validCase, limits: { maxDurationMs: 100.5 } }))
})

test('failed cases are isolated and later EvalCases still execute', async () => {
    const suite = new EvalSuite({
        name: 'isolation',
        variants: ['only'],
        cases: [validCase, { ...validCase, name: 'two' }],
        fixtureFactory: async ({ evalCase }) => {
            if (evalCase.name === 'one') throw new Error('fixture failed')
            return fixture()
        },
        scorer: () => ({ success: true }),
    })
    const report = await runEvalSuite(suite)
    assert.deepEqual(
        report.results.map(({ success }) => success),
        [false, true],
    )
    assert.equal(report.results[0].error.message, 'fixture failed')
})

test('suite assertions reject the run so CLI can fail', async () => {
    const suite = new EvalSuite({
        name: 'assertion',
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => fixture(),
        assertions: [
            () => {
                throw new Error('acceptance failed')
            },
        ],
    })
    await assert.rejects(runEvalSuite(suite), /acceptance failed/)
})

test('scorer receives the named context, and limits reach fixtureFactory', async () => {
    const expected = validCase.expected
    const evalCase = { ...validCase, limits: { maxSteps: 7 } }
    let received
    let factoryInput
    const suite = new EvalSuite({
        name: 'scorer',
        cases: [evalCase],
        variants: ['v'],
        fixtureFactory: async (input) => {
            factoryInput = input
            return fixture()
        },
        scorer: (input) => {
            received = input
            return { success: true, details: { expectedTool: expected.targetTool } }
        },
    })
    const report = await runEvalSuite(suite)
    assert.deepEqual(Object.keys(received).sort(), [
        'evalCase',
        'expected',
        'fixture',
        'trace',
        'variant',
    ])
    assert.equal(received.expected, expected)
    assert.equal(received.evalCase, evalCase)
    assert.equal(received.variant, 'v')
    assert.equal(factoryInput.evalCase, evalCase)
    assert.deepEqual(factoryInput.limits, { maxSteps: 7 })
    assert.equal(report.results[0].suiteName, 'scorer')
    assert.deepEqual(report.results[0].scoreDetails, { expectedTool: 'target' })
})

test('reports have schema version 1 and preserve provider null usage', async () => {
    const report = await runEvalSuite(
        new EvalSuite({
            name: 'schema',
            cases: [validCase],
            variants: ['v'],
            fixtureFactory: async () => fixture(),
            scorer: () => ({ success: true }),
        }),
    )
    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(report.suite, { name: 'schema', variants: ['v'], caseCount: 1 })
    assert.equal(report.results[0].suiteName, 'schema')
    assert.equal(report.results[0].inputTokens, null)
    assert.equal(report.variants.v.inputTokensAvailability, 'unavailable')
    assert.equal(normalizeEvalReportForDeterminism(report).results[0].durationMs, undefined)
})

test('JSON reporter writes a parseable report and Markdown rendering is stable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mini-dsh-eval-'))
    try {
        const path = join(directory, 'nested', 'report.json')
        const report = { schemaVersion: 1, suite: { name: 'test' }, results: [] }
        await writeJsonReport(report, path)
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
    const table = {
        headers: ['variant', 'success'],
        rows: [
            ['guarded', '1/1'],
            ['remind', '1/1'],
        ],
    }
    assert.equal(renderMarkdownTable(table), renderMarkdownTable(table))
    assert.equal(
        renderMarkdownTable(table),
        '| variant | success |\n| ------- | ------- |\n| guarded | 1/1     |\n| remind  | 1/1     |',
    )
})

test('dispose failure is recorded while retaining the EvalResult metrics', async () => {
    let disposed = false
    const report = await new EvalRunner({
        suiteName: 'dispose',
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture({
                requests: [{ visibleToolCount: 2, toolSchemaTokens: 12, estimatedInputTokens: 30 }],
            }),
            async dispose() {
                disposed = true
                throw new Error('dispose failed')
            },
        }),
        scorer: ({ fixture: liveFixture }) => {
            assert.equal(disposed, false)
            assert.equal(liveFixture.inspectors.state, 'live')
            return { success: true, details: { scored: true } }
        },
    }).run()
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0].steps, 1)
    assert.equal(report.results[0].toolCalls, 1)
    assert.equal(report.results[0].requestCount, 1)
    assert.equal(report.results[0].visibleToolCount, 2)
    assert.equal(report.results[0].toolSchemaTokens, 12)
    assert.equal(report.results[0].estimatedInputTokens, 30)
    assert.deepEqual(report.results[0].scoreDetails, { scored: true })
    assert.equal(report.results[0].success, false)
    assert.equal(report.results[0].error.message, 'dispose failed')
    assert.equal(disposed, true)
})

test('fixture remains live throughout scoring and is disposed once afterward', async () => {
    const lifecycle = []
    const report = await new EvalRunner({
        suiteName: 'lifecycle',
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture(),
            inspectors: { state: 'live' },
            async dispose() {
                lifecycle.push('dispose')
            },
        }),
        scorer: ({ fixture: liveFixture }) => {
            lifecycle.push('score')
            assert.equal(liveFixture.inspectors.state, 'live')
            return { success: true }
        },
    }).run()
    assert.equal(report.results[0].success, true)
    assert.deepEqual(lifecycle, ['score', 'dispose'])
})

test('agent.send failure still disposes a created fixture once', async () => {
    let disposeCount = 0
    const report = await new EvalRunner({
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture(),
            agent: {
                async send() {
                    throw new Error('send failed')
                },
            },
            async dispose() {
                disposeCount += 1
            },
        }),
        scorer: () => ({ success: true }),
    }).run()
    assert.equal(disposeCount, 1)
    assert.equal(report.results[0].success, false)
    assert.equal(report.results[0].steps, 1)
    assert.equal(report.results[0].error.message, 'send failed')
})

test('scorer failure still disposes a created fixture once and preserves trace metrics', async () => {
    let disposeCount = 0
    const report = await new EvalRunner({
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture(),
            async dispose() {
                disposeCount += 1
            },
        }),
        scorer: () => {
            throw new Error('score failed')
        },
    }).run()
    assert.equal(disposeCount, 1)
    assert.equal(report.results[0].success, false)
    assert.equal(report.results[0].steps, 1)
    assert.equal(report.results[0].error.message, 'score failed')
})

test('invalid fixture is disposed when possible instead of returning before cleanup', async () => {
    let disposeCount = 0
    const report = await new EvalRunner({
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture(),
            agent: {},
            async dispose() {
                disposeCount += 1
            },
        }),
    }).run()
    assert.equal(disposeCount, 1)
    assert.equal(report.results[0].success, false)
    assert.match(report.results[0].error.message, /Eval fixture must expose/)
})

test('missing trace still disposes a created fixture once', async () => {
    let disposeCount = 0
    const report = await new EvalRunner({
        cases: [validCase],
        variants: ['v'],
        fixtureFactory: async () => ({
            ...fixture(),
            trace: { latest: () => null },
            async dispose() {
                disposeCount += 1
            },
        }),
    }).run()
    assert.equal(disposeCount, 1)
    assert.equal(report.results[0].success, false)
    assert.equal(report.results[0].error.message, 'Eval fixture did not capture a Trace for one/v')
})

test('both existing fixture factories apply every supported limit and preserve defaults', async () => {
    const limits = {
        maxSteps: 4,
        maxToolCalls: 5,
        maxInputTokens: 6,
        maxOutputTokens: 7,
        maxDurationMs: 100.5,
        maxCost: 1.5,
        maxToolFailures: 8,
    }
    const routing = await createToolRoutingFixture({
        evalCase: TOOL_ROUTING_CASES[0],
        variant: 'all',
        limits,
    })
    const progress = await createProgressFixture({
        evalCase: PROGRESS_CASES[0],
        variant: 'baseline',
        limits,
    })
    try {
        assert.deepEqual(routing.inspectors.loop.policy, limits)
        assert.deepEqual(progress.inspectors.loop.policy, { maxSteps: 4, ...limits })
    } finally {
        await routing.dispose()
        await progress.dispose()
    }

    const routingDefault = await createToolRoutingFixture({
        evalCase: TOOL_ROUTING_CASES[0],
        variant: 'all',
    })
    const progressDefault = await createProgressFixture({
        evalCase: PROGRESS_CASES[0],
        variant: 'baseline',
    })
    try {
        assert.deepEqual(routingDefault.inspectors.loop.policy, {})
        assert.deepEqual(progressDefault.inspectors.loop.policy, { maxSteps: 20 })
    } finally {
        await routingDefault.dispose()
        await progressDefault.dispose()
    }
})

test('Markdown table rejects malformed headers and rows with TypeError', () => {
    assert.throws(() => renderMarkdownTable({ headers: [], rows: [] }), TypeError)
    assert.throws(() => renderMarkdownTable({ headers: ['a'], rows: [['a', 'b']] }), TypeError)
})

function fixture({ requests = [] } = {}) {
    return {
        agent: { async send() {} },
        trace: {
            latest: () => ({
                durationMs: 1,
                steps: [{ toolCalls: [{ name: 'target', status: 'completed' }] }],
                stopReason: 'completed',
                usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cost: null },
            }),
        },
        recordingTokenMeter: {
            ...new RecordingTokenMeter(),
            get requests() {
                return requests
            },
        },
        inspectors: { state: 'live' },
    }
}
