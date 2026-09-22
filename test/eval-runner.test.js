import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOL_ROUTING_CASES } from '../evals/tool-routing/cases.js'
import { createToolRoutingFixture } from '../evals/tool-routing/fixture.js'
import { TokenMeter } from '../src/core/token-meter.js'
import { RecordingTokenMeter, summarizeEvalResults } from '../src/eval/eval-metrics.js'
import { CapturingTraceRuntime, EVAL_VARIANTS, EvalRunner } from '../src/eval/eval-runner.js'
import { targetToolCalledScorer } from '../src/eval/eval-scorer.js'

test('tool routing Eval runs every case in the fixed variant order', async () => {
    const report = await new EvalRunner({
        cases: TOOL_ROUTING_CASES,
        fixtureFactory: createToolRoutingFixture,
    }).run()

    assert.equal(report.results.length, TOOL_ROUTING_CASES.length * EVAL_VARIANTS.length)
    assert.deepEqual(
        report.results.slice(0, 6).map(({ caseName, variant }) => [caseName, variant]),
        [
            ['direct-name-match', 'all'],
            ['direct-name-match', 'deterministic'],
            ['direct-name-match', 'progressive'],
            ['description-match', 'all'],
            ['description-match', 'deterministic'],
            ['description-match', 'progressive'],
        ],
    )
    for (const variant of EVAL_VARIANTS) {
        assert.equal(report.variants[variant].cases, 5)
        assert.equal(report.variants[variant].successes, 5)
    }
})

test('target tool scorer distinguishes a call from a successful execution', () => {
    assert.deepEqual(
        targetToolCalledScorer(
            { steps: [{ toolCalls: [{ name: 'target', status: 'error' }] }] },
            { targetTool: 'target' },
        ),
        { targetToolCalled: true, targetToolSucceeded: false, success: false },
    )
    assert.deepEqual(
        targetToolCalledScorer(
            { steps: [{ toolCalls: [{ name: 'target', status: 'completed' }] }] },
            { targetTool: 'target' },
        ),
        { targetToolCalled: true, targetToolSucceeded: true, success: true },
    )
})

test('a failed Eval case is recorded and later cases still execute', async () => {
    const cases = [
        { name: 'broken', prompt: 'fail', expected: { targetTool: 'target' } },
        { name: 'healthy', prompt: 'run', expected: { targetTool: 'target' } },
    ]
    const fixtureFactory = async (evalCase) => {
        if (evalCase.name === 'broken') throw new Error('fixture failed')
        const recordingTokenMeter = new RecordingTokenMeter()
        return {
            agent: { async send() {} },
            trace: { latest: () => successfulTrace() },
            recordingTokenMeter,
        }
    }

    const report = await new EvalRunner({ cases, fixtureFactory }).run()
    assert.equal(report.results.length, 6)
    assert.deepEqual(
        report.results
            .filter(({ variant }) => variant === 'all')
            .map(({ caseName, success }) => [caseName, success]),
        [
            ['broken', false],
            ['healthy', true],
        ],
    )
    assert.deepEqual(report.results[0].error, { name: 'Error', message: 'fixture failed' })
})

test('RecordingTokenMeter returns the real estimate and counts only request Tool schemas', () => {
    const tokenMeter = new TokenMeter()
    const recordingTokenMeter = new RecordingTokenMeter({ tokenMeter })
    const request = {
        model: 'mock/model',
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            },
        ],
    }

    assert.deepEqual(
        recordingTokenMeter.estimateRequest(request),
        tokenMeter.estimateRequest(request),
    )
    assert.deepEqual(recordingTokenMeter.requests, [
        {
            visibleToolCount: 1,
            toolSchemaTokens: tokenMeter.estimateRequest({ tools: request.tools }).tokens,
        },
    ])
})

test('Captured Trace exposes the production steps, Tool calls, and stop reason', async () => {
    const evalCase = TOOL_ROUTING_CASES[0]
    const fixture = await createToolRoutingFixture(evalCase, 'all')
    try {
        await fixture.agent.send(evalCase.prompt)
        const trace = fixture.trace.latest()
        assert.equal(trace.steps.length, 2)
        assert.equal(
            trace.steps.reduce((count, step) => count + step.toolCalls.length, 0),
            1,
        )
        assert.equal(trace.steps[0].toolCalls[0].name, 'read_file')
        assert.equal(trace.steps[0].toolCalls[0].status, 'completed')
        assert.equal(trace.stopReason, 'completed')
    } finally {
        await fixture.dispose()
    }
})

test('summary aggregation keeps unknown provider usage unavailable, not zero', () => {
    const report = summarizeEvalResults(
        [
            {
                variant: 'all',
                success: true,
                steps: 2,
                toolCalls: 1,
                visibleToolCount: 10,
                maxVisibleToolCount: 5,
                toolSchemaTokens: 90,
                inputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                cost: null,
                durationMs: 2,
            },
        ],
        ['all'],
    ).all

    assert.equal(report.totalInputTokens, null)
    assert.equal(report.inputTokensAvailability, 'unavailable')
    assert.equal(report.totalOutputTokens, null)
    assert.equal(report.outputTokensAvailability, 'unavailable')
    assert.equal(report.totalReasoningTokens, null)
    assert.equal(report.reasoningTokensAvailability, 'unavailable')
    assert.equal(report.totalCost, null)
    assert.equal(report.costAvailability, 'unavailable')
    assert.equal(report.avgVisibleTools, 5)
    assert.equal(report.totalToolSchemaTokens, 90)
})

test('repeated Eval runs keep all functional metrics deterministic', async () => {
    const cases = [TOOL_ROUTING_CASES[2], TOOL_ROUTING_CASES[3]]
    const first = await new EvalRunner({ cases, fixtureFactory: createToolRoutingFixture }).run()
    const second = await new EvalRunner({ cases, fixtureFactory: createToolRoutingFixture }).run()
    const functionalMetrics = (report) =>
        report.results.map((result) => ({
            caseName: result.caseName,
            variant: result.variant,
            success: result.success,
            steps: result.steps,
            toolCalls: result.toolCalls,
            visibleToolCount: result.visibleToolCount,
            maxVisibleToolCount: result.maxVisibleToolCount,
            toolSchemaTokens: result.toolSchemaTokens,
            toolSchemaTokensByStep: result.toolSchemaTokensByStep,
        }))

    assert.deepEqual(functionalMetrics(first), functionalMetrics(second))
})

test('progressive cross-language Eval searches before target visibility and beats all schema cost for large catalogs', async () => {
    const fixtures = []
    const cases = [TOOL_ROUTING_CASES[2], TOOL_ROUTING_CASES[3], TOOL_ROUTING_CASES[4]]
    const report = await new EvalRunner({
        cases,
        fixtureFactory: async (...args) => {
            const fixture = await createToolRoutingFixture(...args)
            fixtures.push({ variant: args[1], fixture })
            return fixture
        },
    }).run()

    const crossLanguage = report.results.find(
        ({ caseName, variant }) =>
            caseName === 'github-issues-cross-language' && variant === 'progressive',
    )
    assert.equal(crossLanguage.success, true)
    try {
        const progressiveFixture = fixtures.find(({ variant }) => variant === 'progressive').fixture
        assert.deepEqual(
            progressiveFixture.llmRequests[0].tools.map((schema) => schema.function.name),
            ['tool_search'],
        )
        assert.ok(
            progressiveFixture.llmRequests[1].tools.some(
                (schema) => schema.function.name === 'github_issues_search',
            ),
        )
        for (const { fixture } of fixtures) {
            for (const [index, request] of fixture.llmRequests.entries()) {
                assert.equal(
                    fixture.recordingTokenMeter.requests[index].visibleToolCount,
                    request.tools.length,
                )
                assert.equal(
                    fixture.recordingTokenMeter.requests[index].toolSchemaTokens,
                    new TokenMeter().estimateRequest({ tools: request.tools }).tokens,
                )
            }
        }
    } finally {
        for (const { fixture } of fixtures) await fixture.dispose()
    }

    const allLarge = report.results.find(
        ({ caseName, variant }) => caseName === 'large-noisy-catalog' && variant === 'all',
    )
    const progressiveLarge = report.results.find(
        ({ caseName, variant }) => caseName === 'large-noisy-catalog' && variant === 'progressive',
    )
    assert.ok(progressiveLarge.toolSchemaTokens < allLarge.toolSchemaTokens)
})

test('CapturingTraceRuntime wraps the TraceRuntime handle contract', async () => {
    const trace = new CapturingTraceRuntime()
    const run = trace.startRun({ sessionId: 'session', model: 'mock/model' })
    const step = run.startStep()
    step.startLlm()
    step.finishLlm()
    step.startToolCall({ id: 'call', name: 'target' }).finish('completed')
    step.finish()
    await run.finish('completed')
    assert.equal(trace.latest().stopReason, 'completed')
    assert.equal(trace.latest().steps[0].toolCalls[0].status, 'completed')
})

function successfulTrace() {
    return {
        stopReason: 'completed',
        steps: [{ toolCalls: [{ name: 'target', status: 'completed' }] }],
        usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cost: null },
    }
}
