import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTEXT_PRESSURE_CASES } from '../evals/context-pressure/cases.js'
import { CONTEXT_POLICY } from '../evals/context-pressure/fixture.js'
import { createContextPressureSuite } from '../evals/context-pressure/suite.js'
import { normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { runEvalSuite } from '../src/eval/eval-suite.js'

const VARIANTS = ['full-history', 'constrained', 'compacted']

test('context-pressure suite declares the three ordered variants and three expected cases', async () => {
    const suite = createContextPressureSuite()
    const report = await runEvalSuite(suite)

    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(report.suite, {
        name: 'context-pressure',
        variants: VARIANTS,
        caseCount: 3,
    })
    assert.deepEqual(
        CONTEXT_PRESSURE_CASES.map(({ name }) => name),
        ['long-history-pressure', 'recent-context-preservation', 'tool-protocol-pressure'],
    )
    assert.deepEqual(
        report.results.slice(0, 3).map(({ variant }) => variant),
        VARIANTS,
    )
})

test('ContextManager planner estimates do not inflate actual model request metrics', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    const compactedResults = report.results.filter((result) => result.variant === 'compacted')
    for (const result of compactedResults) {
        assert.equal(result.requestCount, result.scoreDetails.modelRequestCount)
        assert.equal(result.requestCount, result.estimatedInputTokensByStep.length)
        assert.ok(
            result.scoreDetails.internalContextEstimateCalls > result.requestCount,
            `${result.caseName} should show internal planner estimates separate from LLM requests`,
        )
    }
})

test('full-history completes, constrained overflows, and compacted completes with compaction', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    for (const evalCase of CONTEXT_PRESSURE_CASES) {
        const fullHistory = resultFor(report, evalCase.name, 'full-history')
        const constrained = resultFor(report, evalCase.name, 'constrained')
        const compacted = resultFor(report, evalCase.name, 'compacted')
        assert.equal(fullHistory.success, true)
        assert.equal(fullHistory.stopReason, 'completed')
        assert.equal(compacted.success, true)
        assert.equal(compacted.stopReason, 'completed')
        assert.ok(compacted.scoreDetails.compactionCount >= 1)
        assert.equal(constrained.success, true)
    }
    const constrainedPressure = resultFor(report, 'long-history-pressure', 'constrained')
    assert.equal(constrainedPressure.stopReason, 'context_overflow')
    assert.equal(constrainedPressure.scoreDetails.finishSucceeded, false)
})

test('context window is finite for constrained and compacted variants', () => {
    assert.deepEqual(CONTEXT_POLICY, {
        maxContextTokens: 1900,
        reservedOutputTokens: 200,
        compactAtRatio: 0.72,
    })
})

test('long-history compaction lowers peak request and cumulative estimated input', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    const fullHistory = resultFor(report, 'long-history-pressure', 'full-history')
    const compacted = resultFor(report, 'long-history-pressure', 'compacted')
    assert.ok(peak(compacted) < peak(fullHistory))
    assert.ok(compacted.estimatedInputTokens < fullHistory.estimatedInputTokens)
})

test('compacted recent-context case retains markers from model-visible request messages', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    const compacted = resultFor(report, 'recent-context-preservation', 'compacted')
    assert.equal(compacted.scoreDetails.recentContextPreserved, true)
    assert.equal(compacted.scoreDetails.goalPreserved, true)
})

test('protocol case completes every Tool Call and keeps compaction boundaries safe', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    const compacted = resultFor(report, 'tool-protocol-pressure', 'compacted')
    assert.equal(compacted.scoreDetails.protocolComplete, true)
    assert.equal(compacted.scoreDetails.protocolBoundarySafe, true)
})

test('compaction appends events without deleting durable events and summaries remain assistant context', async () => {
    const report = await runEvalSuite(createContextPressureSuite())
    const compacted = resultFor(report, 'tool-protocol-pressure', 'compacted')
    assert.equal(compacted.scoreDetails.originalEventsPreserved, true)
    assert.equal(compacted.scoreDetails.summarySafetyPreserved, true)
})

test('repeated context-pressure Eval runs are deterministic apart from duration', async () => {
    const first = await runEvalSuite(createContextPressureSuite())
    const second = await runEvalSuite(createContextPressureSuite())
    assert.deepEqual(
        normalizeEvalReportForDeterminism(second),
        normalizeEvalReportForDeterminism(first),
    )
})

function resultFor(report, caseName, variant) {
    const result = report.results.find(
        (entry) => entry.caseName === caseName && entry.variant === variant,
    )
    assert.ok(result, `missing result ${caseName}/${variant}`)
    return result
}

function peak(result) {
    return Math.max(...result.estimatedInputTokensByStep)
}
