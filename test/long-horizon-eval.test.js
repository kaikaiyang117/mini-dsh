import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { LONG_HORIZON_CASES } from '../evals/long-horizon/cases.js'
import { createLongHorizonFixture, scoreLongHorizon } from '../evals/long-horizon/fixture.js'
import { createLongHorizonSuite } from '../evals/long-horizon/suite.js'
import { normalizeEvalReportForDeterminism } from '../src/eval/eval-runner.js'
import { runEvalSuite } from '../src/eval/eval-suite.js'

const VARIANTS = ['baseline', 'managed']
let sharedReport

function report() {
    sharedReport ??= runEvalSuite(createLongHorizonSuite())
    return sharedReport
}

test('long-horizon suite declares isolated synthetic coding cases and baseline/managed variants', async () => {
    const result = await report()
    assert.deepEqual(result.suite, {
        name: 'long-horizon-filesystem',
        variants: VARIANTS,
        caseCount: 5,
    })
    assert.deepEqual(
        LONG_HORIZON_CASES.map(({ name }) => name),
        [
            'targeted-bug-fix',
            'cross-file-change',
            'failed-first-search',
            'failed-edit-recovery',
            'large-context-fix',
        ],
    )
    assert.equal(result.results.length, LONG_HORIZON_CASES.length * VARIANTS.length)
})

test('baseline and managed both produce correct final workspaces with complete Tool protocols', async () => {
    const result = await report()
    for (const evalResult of result.results) {
        assert.equal(evalResult.success, true, `${evalResult.caseName}/${evalResult.variant}`)
        assert.equal(evalResult.stopReason, 'completed')
        assert.equal(evalResult.scoreDetails.targetCorrect, true)
        assert.equal(evalResult.scoreDetails.finalTestsPassed, true)
        assert.equal(evalResult.scoreDetails.requiredReadsSatisfied, true)
        assert.equal(evalResult.scoreDetails.requiredModificationsSatisfied, true)
        assert.deepEqual(
            evalResult.scoreDetails.workspaceChangedFiles,
            evalResult.scoreDetails.filesModified,
        )
        assert.deepEqual(evalResult.scoreDetails.unexpectedModifiedFiles, [])
        assert.equal(evalResult.scoreDetails.noForbiddenFileChanges, true)
        assert.equal(evalResult.scoreDetails.workspaceFilesOnly, true)
        assert.equal(evalResult.scoreDetails.noWorkspaceExternalWrites, true)
        assert.equal(evalResult.scoreDetails.bashStayedInWorkspace, true)
        assert.equal(evalResult.scoreDetails.bashCommandsSafe, true)
        assert.equal(evalResult.scoreDetails.protocolComplete, true)
        assert.equal(evalResult.requestCount, evalResult.scoreDetails.modelRequestCount)
        assert.equal(evalResult.requestCount, evalResult.estimatedInputTokensByStep.length)
        assert.ok(evalResult.steps >= 6 && evalResult.steps <= 12)
        assert.equal(evalResult.scoreDetails.testRuns, 2)
        assert.deepEqual(evalResult.scoreDetails.testExitCodes, [1, 0])
        assert.equal(evalResult.scoreDetails.initialTestsFailed, true)
        assert.equal(evalResult.scoreDetails.finalTestsPassed, true)
    }
    for (const evalCase of LONG_HORIZON_CASES) {
        for (const variant of VARIANTS) {
            const scored = resultFor(result, evalCase.name, variant).scoreDetails
            assert.deepEqual(scored.workspaceChangedFiles, evalCase.modifiedFiles)
            assert.deepEqual(scored.unexpectedModifiedFiles, [])
        }
        assert.deepEqual(
            resultFor(result, evalCase.name, 'managed').scoreDetails.toolSequence,
            resultFor(result, evalCase.name, 'baseline').scoreDetails.toolSequence,
            `${evalCase.name} should follow the same Mock LLM policy in both variants`,
        )
    }
})

test('one empty first search is recoverable and does not trigger a false-positive guard', async () => {
    const evalReport = await report()
    const managed = resultFor(evalReport, 'failed-first-search', 'managed')
    assert.equal(managed.success, true)
    assert.deepEqual(managed.scoreDetails.searchQueries, ['MISSING_CLAMP_SYMBOL', 'function clamp'])
    assert.equal(managed.scoreDetails.progressStops, 0)
    assert.equal(managed.scoreDetails.reminderCount, 0)
})

test('failed exact edit records a Tool Error, re-reads the file, and recovers', async () => {
    const evalReport = await report()
    for (const variant of VARIANTS) {
        const result = resultFor(evalReport, 'failed-edit-recovery', variant)
        assert.ok(result.scoreDetails.toolFailures >= 1)
        assert.equal(result.scoreDetails.protocolComplete, true)
        const names = result.scoreDetails.toolSequence
        const failedEditIndex = names.indexOf('edit_file')
        assert.ok(failedEditIndex >= 0)
        assert.equal(names[failedEditIndex + 1], 'read_file')
        assert.equal(names.filter((name) => name === 'edit_file').length, 2)
    }
})

test('managed large-context workflow compacts and lowers peak request input without losing the task', async () => {
    const evalReport = await report()
    const baseline = resultFor(evalReport, 'large-context-fix', 'baseline')
    const managed = resultFor(evalReport, 'large-context-fix', 'managed')
    assert.equal(baseline.scoreDetails.compactionCount, 0)
    assert.ok(managed.scoreDetails.compactionCount >= 1)
    assert.equal(managed.success, true)
    assert.ok(peak(managed) < peak(baseline))
})

test('long-horizon functional report is deterministic apart from duration', async () => {
    const first = await report()
    const second = await runEvalSuite(createLongHorizonSuite())
    assert.deepEqual(
        normalizeEvalReportForDeterminism(second),
        normalizeEvalReportForDeterminism(first),
    )
})

test('fixture scorer can inspect the workspace before dispose removes it', async () => {
    const evalCase = LONG_HORIZON_CASES[0]
    const fixture = await createLongHorizonFixture({ evalCase, variant: 'baseline' })
    const workspace = fixture.inspectors.workspace
    try {
        await fixture.agent.send(evalCase.prompt)
        const score = scoreLongHorizon({
            trace: fixture.trace.latest(),
            expected: evalCase.expected,
            variant: 'baseline',
            evalCase,
            fixture,
        })
        assert.equal(score.success, true)
        assert.equal(existsSync(workspace), true)
    } finally {
        await fixture.dispose()
    }
    assert.equal(existsSync(workspace), false)
})

test('scorer rejects unrelated workspace mutations even when the target patch and tests pass', async () => {
    const evalCase = LONG_HORIZON_CASES[0]
    const fixture = await createLongHorizonFixture({ evalCase, variant: 'baseline' })
    try {
        await fixture.agent.send(evalCase.prompt)
        const unrelatedPath = `${fixture.inspectors.workspace}/src/unrelated.js`
        writeFileSync(
            unrelatedPath,
            `${fixture.inspectors.initialFiles['src/unrelated.js']}\n// unexpected`,
        )
        const score = scoreLongHorizon({
            trace: fixture.trace.latest(),
            evalCase,
            fixture,
        })
        assert.deepEqual(score.details.unexpectedModifiedFiles, ['src/unrelated.js'])
        assert.equal(score.details.targetCorrect, true)
        assert.equal(score.details.finalTestsPassed, true)
        assert.equal(score.success, false)
    } finally {
        await fixture.dispose()
    }
})

test('successful write records do not satisfy required modification without a final file diff', async () => {
    const evalCase = LONG_HORIZON_CASES[0]
    const fixture = await createLongHorizonFixture({ evalCase, variant: 'baseline' })
    try {
        await fixture.agent.send(evalCase.prompt)
        writeFileSync(
            `${fixture.inspectors.workspace}/${evalCase.targetFile}`,
            fixture.inspectors.initialFiles[evalCase.targetFile],
        )
        const score = scoreLongHorizon({
            trace: fixture.trace.latest(),
            evalCase,
            fixture,
        })
        assert.ok(score.details.filesModified.includes(evalCase.targetFile))
        assert.equal(score.details.workspaceChangedFiles.includes(evalCase.targetFile), false)
        assert.equal(score.details.requiredModificationsSatisfied, false)
        assert.equal(score.success, false)
    } finally {
        await fixture.dispose()
    }
})

function resultFor(report, caseName, variant) {
    const result = report.results.find(
        (entry) => entry.caseName === caseName && entry.variant === variant,
    )
    assert.ok(result, `missing ${caseName}/${variant}`)
    return result
}

function peak(result) {
    return Math.max(...result.estimatedInputTokensByStep)
}
