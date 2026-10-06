import { spawnSync } from 'node:child_process'
import { diffWorkspace, snapshotWorkspace } from './workspace.js'

export async function scoreCodingCase({ trace, fixture, evalCase }) {
    const { workspace, session, initialSnapshot } = fixture.inspectors
    const calls = session.events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls)
    const results = session.events.filter((event) => event.type === 'tool/result')
    const ids = new Set(calls.map((call) => call.id))
    const counts = new Map()
    for (const result of results)
        counts.set(result.data.toolCallId, (counts.get(result.data.toolCallId) ?? 0) + 1)
    const protocolComplete =
        ids.size === calls.length &&
        results.length === calls.length &&
        results.every((result) => ids.has(result.data.toolCallId)) &&
        calls.every((call) => counts.get(call.id) === 1)
    const finalSnapshot = await snapshotWorkspace(workspace)
    const diff = diffWorkspace(initialSnapshot, finalSnapshot)
    const unexpectedModifiedFiles = diff.modifiedFiles.filter(
        (name) => !evalCase.allowedModifiedFiles.includes(name),
    )
    const unexpectedCreatedFiles = diff.createdFiles.filter(
        (name) => !evalCase.allowedCreatedFiles.includes(name),
    )
    const workspacePolicyValid =
        unexpectedModifiedFiles.length === 0 &&
        unexpectedCreatedFiles.length === 0 &&
        diff.deletedFiles.length === 0
    const agentTestRuns = results
        .filter((result) => result.data.name === 'bash' && !result.data.isError)
        .map((result) => {
            try {
                return JSON.parse(result.data.content)
            } catch {
                return null
            }
        })
        .filter((value) => value?.command === evalCase.publicTestCommand)
    const agentObservedFailingTest = agentTestRuns.some((run) => run.exitCode !== 0)
    const agentObservedPassingTest = agentTestRuns.some((run) => run.exitCode === 0)
    const publicRun = spawnSync('bash', ['-lc', evalCase.publicTestCommand], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    })
    const publicTestsPassed = publicRun.status === 0
    let verifierDetails = null
    let hiddenTestsPassed = false
    try {
        verifierDetails = await evalCase.verifier({ workspace, initialSnapshot, finalSnapshot })
        hiddenTestsPassed = verifierDetails === true || verifierDetails?.passed === true
        verifierDetails = {
            passed: hiddenTestsPassed,
            reason: String(verifierDetails?.reason ?? '').slice(0, 500),
        }
    } catch (error) {
        verifierDetails = { passed: false, reason: String(error.message).slice(0, 500) }
    }
    const details = {
        category: evalCase.category,
        difficulty: evalCase.difficulty,
        tags: evalCase.tags,
        baselineValid: fixture.inspectors.baselineValid ?? true,
        publicTestsPassed,
        hiddenTestsPassed,
        createdFiles: diff.createdFiles,
        modifiedFiles: diff.modifiedFiles,
        deletedFiles: diff.deletedFiles,
        unexpectedModifiedFiles,
        unexpectedCreatedFiles,
        agentRanTests: agentTestRuns.length > 0,
        agentTestRuns,
        agentObservedFailingTest,
        agentObservedPassingTest,
        protocolComplete,
        verifierDetails,
    }
    return {
        success:
            trace.stopReason === 'completed' &&
            details.baselineValid &&
            publicTestsPassed &&
            hiddenTestsPassed &&
            workspacePolicyValid &&
            details.agentRanTests &&
            protocolComplete,
        details,
    }
}
