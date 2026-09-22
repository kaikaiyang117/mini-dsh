import assert from 'node:assert/strict'
import test from 'node:test'
import { createCrashRecoverySuite } from '../evals/crash-recovery/suite.js'
import { normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { runEvalSuite } from '../src/eval/eval-suite.js'

test('crash recovery suite uses the real process restart matrix', async () => {
    const report = await runEvalSuite(createCrashRecoverySuite())
    assert.equal(report.results.length, 5)
    for (const result of report.results) {
        assert.equal(result.success, true)
        assert.equal(result.scoreDetails.protocolComplete, true)
        assert.equal(result.scoreDetails.sequenceContinuous, true)
    }
    const sideEffect = report.results.find(
        (result) => result.caseName === 'crash-after-side-effect-start',
    )
    assert.equal(sideEffect.scoreDetails.recoveredUnknownCount, 1)
    assert.equal(sideEffect.scoreDetails.sideEffectExecutionCountAfterResume, 0)
    assert.equal(sideEffect.scoreDetails.doubleRestartIdempotent, true)
})

test('crash recovery functional report is deterministic apart from duration', async () => {
    const first = normalizeEvalReportForDeterminism(await runEvalSuite(createCrashRecoverySuite()))
    const second = normalizeEvalReportForDeterminism(await runEvalSuite(createCrashRecoverySuite()))
    assert.deepEqual(first, second)
})
