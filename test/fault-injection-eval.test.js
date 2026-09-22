import assert from 'node:assert/strict'
import test from 'node:test'
import { FAULT_INJECTION_CASES } from '../evals/fault-injection/cases.js'
import { FaultInjector, INJECTION_POINTS } from '../evals/fault-injection/fault-injector.js'
import {
    assertToolProtocolComplete,
    createFaultInjectionFixture,
} from '../evals/fault-injection/fixture.js'
import { createFaultInjectionSuite } from '../evals/fault-injection/suite.js'
import { normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { runEvalSuite } from '../src/eval/eval-suite.js'

let sharedReport

function report() {
    sharedReport ??= runEvalSuite(createFaultInjectionSuite())
    return sharedReport
}

test('FaultInjector applies simple point/tool/occurrence rules deterministically', () => {
    const injector = new FaultInjector([
        { point: 'tool.execute', tool: 'unstable_tool', occurrence: 2, action: 'throw' },
    ])
    assert.equal(injector.shouldFail('tool.execute', { tool: 'other' }), false)
    assert.equal(injector.shouldFail('tool.execute', { tool: 'unstable_tool' }), false)
    assert.equal(injector.shouldFail('tool.execute', { tool: 'unstable_tool' }), true)
    assert.equal(injector.matchedAction, 'throw')
    injector.record('tool.execute', { tool: 'unstable_tool' })
    assert.equal(injector.injectedCount, 1)
    assert.deepEqual(injector.injections, [
        {
            point: 'tool.execute',
            tool: 'unstable_tool',
            occurrence: 2,
            action: 'throw',
        },
    ])
    assert.equal(INJECTION_POINTS.size, 7)
    assert.throws(
        () => new FaultInjector([{ point: 'unknown.point', occurrence: 1, action: 'throw' }]),
        /FaultInjector rules/,
    )
})

test('protocol helper requires exactly one Result for each committed Tool Call', () => {
    const call = { type: 'assistant/tool_calls', data: { toolCalls: [{ id: 'call-1' }] } }
    const result = { type: 'tool/result', data: { toolCallId: 'call-1' } }
    assert.equal(assertToolProtocolComplete([call, result]), true)
    assert.throws(() => assertToolProtocolComplete([call]), /protocol is incomplete/)
    assert.throws(() => assertToolProtocolComplete([call, result, result]), /duplicated/)
})

test('fault-injection suite declares the expected deterministic core failure matrix', async () => {
    const evalReport = await report()
    assert.deepEqual(evalReport.suite, {
        name: 'fault-injection-core-runtime',
        variants: ['default'],
        caseCount: 11,
    })
    assert.deepEqual(
        FAULT_INJECTION_CASES.map(({ name }) => name),
        [
            'llm-provider-error',
            'llm-pending-cancel',
            'tool-error-recovery',
            'tool-error-limit',
            'tool-timeout',
            'invalid-tool-args',
            'unknown-tool',
            'parallel-cancel',
            'context-overflow',
            'post-commit-dispatch-failure',
            'side-effect-no-retry',
        ],
    )
    for (const result of evalReport.results) {
        assert.equal(result.success, true, result.caseName)
        assert.equal(result.stopReason, result.scoreDetails.expectedStopReason)
        assert.equal(result.scoreDetails.protocolComplete, true)
        assert.deepEqual(result.scoreDetails.duplicateToolResultIds, [])
        assert.deepEqual(result.scoreDetails.unmatchedToolCallIds, [])
        assert.equal(result.scoreDetails.caseInvariant, true)
    }
})

test('provider error and pending cancellation retain trace semantics without a timeout policy', async () => {
    const evalReport = await report()
    const providerError = resultFor(evalReport, 'llm-provider-error')
    assert.equal(providerError.stopReason, 'internal_error')
    assert.equal(providerError.scoreDetails.providerFailureCode, 'PROVIDER_500')
    assert.equal(providerError.scoreDetails.traceStepCount, 1)
    assert.equal(providerError.requestCount, 1)

    const pendingCancel = resultFor(evalReport, 'llm-pending-cancel')
    assert.equal(pendingCancel.stopReason, 'cancelled')
    assert.equal(pendingCancel.scoreDetails.providerTimeoutPolicy, 'not_implemented')
    assert.equal(pendingCancel.scoreDetails.traceStepCount, 1)
})

test('tool recovery and failure limit use Tool Runtime errors and policy stop reasons', async () => {
    const evalReport = await report()
    const recovery = resultFor(evalReport, 'tool-error-recovery')
    assert.equal(recovery.stopReason, 'completed')
    assert.deepEqual(recovery.scoreDetails.toolErrorCodes, ['execution_error'])
    assert.deepEqual(recovery.scoreDetails.toolResultErrorCodes, ['execution_error', null])

    const limited = resultFor(evalReport, 'tool-error-limit')
    assert.equal(limited.stopReason, 'tool_failure_limit')
    assert.deepEqual(limited.scoreDetails.toolErrorCodes, ['execution_error', 'execution_error'])
})

test('timeout, invalid arguments, and unknown Tools keep normalized error results', async () => {
    const evalReport = await report()
    const timedOut = resultFor(evalReport, 'tool-timeout')
    assert.equal(timedOut.scoreDetails.timeoutErrorCode, 'timeout')
    assert.equal(timedOut.scoreDetails.timeoutTraceStatus, true)

    assert.deepEqual(resultFor(evalReport, 'invalid-tool-args').scoreDetails.toolErrorCodes, [
        'invalid_arguments',
    ])
    assert.deepEqual(resultFor(evalReport, 'unknown-tool').scoreDetails.toolErrorCodes, [
        'unknown_tool',
    ])
})

test('parallel cancellation waits for all Tools to start and closes the three-call protocol', async () => {
    const result = resultFor(await report(), 'parallel-cancel')
    assert.equal(result.stopReason, 'cancelled')
    assert.equal(result.scoreDetails.parallelStarted, 2)
    assert.equal(result.scoreDetails.toolCallCount, 3)
    assert.equal(result.scoreDetails.toolResultCount, 3)
    assert.deepEqual(result.scoreDetails.traceToolStatuses, ['completed', 'cancelled', 'cancelled'])
})

test('context overflow retains the completed committed Tool step and event log', async () => {
    const result = resultFor(await report(), 'context-overflow')
    assert.equal(result.stopReason, 'context_overflow')
    assert.deepEqual(result.scoreDetails.eventTypes, [
        'session/start',
        'user/message',
        'assistant/tool_calls',
        'tool/result',
    ])
})

test('post-commit scheduler failure is repaired and side effects are not retried', async () => {
    const evalReport = await report()
    const dispatchFailure = resultFor(evalReport, 'post-commit-dispatch-failure')
    assert.equal(dispatchFailure.stopReason, 'internal_error')
    assert.equal(dispatchFailure.scoreDetails.toolCallCount, 1)
    assert.equal(dispatchFailure.scoreDetails.toolResultCount, 1)
    assert.equal(dispatchFailure.scoreDetails.toolErrorCodes[0], null)

    const sideEffect = resultFor(evalReport, 'side-effect-no-retry')
    assert.equal(sideEffect.stopReason, 'internal_error')
    assert.equal(sideEffect.scoreDetails.sideEffectExecutionCount, 1)
})

test('fault-injection functional results are deterministic apart from duration', async () => {
    const first = await report()
    const second = await runEvalSuite(createFaultInjectionSuite())
    assert.deepEqual(
        normalizeEvalReportForDeterminism(second),
        normalizeEvalReportForDeterminism(first),
    )
})

test('fixtures retain trace and session events when Agent.send rejects', async () => {
    const evalCase = FAULT_INJECTION_CASES[0]
    const fixture = await createFaultInjectionFixture({ evalCase })
    try {
        await fixture.agent.send(evalCase.prompt)
        assert.equal(fixture.trace.latest().stopReason, 'internal_error')
        assert.deepEqual(
            fixture.inspectors.session.events.map((event) => event.type),
            ['session/start', 'user/message'],
        )
    } finally {
        await fixture.dispose()
    }
})

function resultFor(evalReport, caseName) {
    const result = evalReport.results.find((entry) => entry.caseName === caseName)
    assert.ok(result, `missing ${caseName}`)
    return result
}
