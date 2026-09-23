import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpFailureSuite } from '../evals/mcp-failure/suite.js'
import { normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { runEvalSuite } from '../src/eval/eval-suite.js'

test('MCP failure Eval covers lifecycle, stale schema, and remote-like failure semantics', async () => {
    const report = await runEvalSuite(createMcpFailureSuite())
    assert.equal(report.results.length, 9)
    assert.ok(report.results.every((result) => result.success))
    const stale = report.results.find(
        (result) => result.caseName === 'stale-schema-after-disconnect',
    )
    assert.equal(stale.scoreDetails.staleSchemaVisible, true)
    assert.equal(stale.scoreDetails.staleToolReturnedUnknown, true)
    assert.equal(stale.scoreDetails.toolErrorCode, 'unknown_tool')
    assert.equal(stale.scoreDetails.modelSawToolFailure, true)
    assert.equal(stale.scoreDetails.toolLeakCount, 0)
    const remote = report.results.find(
        (result) => result.caseName === 'active-plugin-tool-execution-failure',
    )
    assert.equal(remote.scoreDetails.managerStateAfterToolFailure, 'ACTIVE')
    assert.equal(remote.scoreDetails.toolFailures, 1)
    assert.equal(remote.scoreDetails.toolErrorCode, 'execution_error')
    assert.equal(remote.scoreDetails.toolIsError, true)
    assert.match(remote.scoreDetails.toolFailure, /remote MCP unavailable/)
    assert.equal(remote.scoreDetails.modelSawToolFailure, true)
    assert.equal(remote.scoreDetails.toolLeakCount, 0)
    const mixed = report.results.find((result) => result.caseName === 'mixed-server-isolation')
    assert.equal(mixed.scoreDetails.brokenToolAbsent, true)
    assert.equal(mixed.scoreDetails.toolLeakCount, 0)
    const reload = report.results.find((result) => result.caseName === 'reload-restores-tools')
    assert.equal(reload.scoreDetails.reloadCreatedNewFiber, true)
    assert.equal(reload.scoreDetails.toolRegistrationCount, 1)
    const reloadFailure = report.results.find(
        (result) => result.caseName === 'reload-cleanup-failure',
    )
    assert.equal(reloadFailure.scoreDetails.activationAttempts, 1)
    assert.equal(reloadFailure.scoreDetails.oldToolRetained, true)
    assert.equal(reloadFailure.scoreDetails.toolRegistrationCount, 1)
    const partialDispose = report.results.find(
        (result) => result.caseName === 'manager-dispose-partial-failure',
    )
    assert.equal(partialDispose.scoreDetails.cleanupRetried, true)
    assert.deepEqual(partialDispose.scoreDetails.registeredToolNamesAfterFirstDispose, [
        'mcp__server-b__tool',
    ])
})

test('MCP failure functional report is deterministic', async () => {
    const first = normalizeEvalReportForDeterminism(await runEvalSuite(createMcpFailureSuite()))
    const second = normalizeEvalReportForDeterminism(await runEvalSuite(createMcpFailureSuite()))
    assert.deepEqual(first, second)
})
