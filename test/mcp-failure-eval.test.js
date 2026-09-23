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
    const remote = report.results.find(
        (result) => result.caseName === 'active-plugin-tool-execution-failure',
    )
    assert.equal(remote.scoreDetails.managerStateAfterToolFailure, 'ACTIVE')
    assert.equal(remote.scoreDetails.toolFailures, 1)
})

test('MCP failure functional report is deterministic', async () => {
    const first = normalizeEvalReportForDeterminism(await runEvalSuite(createMcpFailureSuite()))
    const second = normalizeEvalReportForDeterminism(await runEvalSuite(createMcpFailureSuite()))
    assert.deepEqual(first, second)
})
