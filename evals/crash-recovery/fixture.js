import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCrashWorker } from './process-runner.js'

export async function createCrashRecoveryFixture({ evalCase }) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mini-dsh-crash-recovery-'))
    const sessionsDirectory = path.join(root, 'sessions')
    const effectsDirectory = path.join(root, 'external-effects')
    let crashResult
    let resumeResult
    let reopenResult
    return {
        agent: {
            async send() {
                crashResult = await runCrashWorker({
                    directory: sessionsDirectory,
                    effectsDirectory,
                    caseName: evalCase.name,
                    phase: 'crash',
                })
                const sessionId = crashResult.sessionId
                resumeResult = await runCrashWorker({
                    directory: sessionsDirectory,
                    effectsDirectory,
                    caseName: evalCase.name,
                    phase: 'resume',
                    sessionId,
                })
                if (evalCase.name === 'crash-after-side-effect-start') {
                    reopenResult = await runCrashWorker({
                        directory: sessionsDirectory,
                        effectsDirectory,
                        caseName: evalCase.name,
                        phase: 'reopen',
                        sessionId,
                    })
                }
            },
        },
        trace: { latest: () => resumeResult?.trace ?? null },
        recordingTokenMeter: { requests: [] },
        inspectors: {
            get result() {
                return { crash: crashResult, resume: resumeResult, reopen: reopenResult }
            },
            async readEvents() {
                const id = resumeResult?.sessionId
                if (!id) return []
                const contents = await readFile(
                    path.join(sessionsDirectory, id, 'session.jsonl'),
                    'utf8',
                )
                return contents
                    .trimEnd()
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line))
            },
            async effectCount() {
                try {
                    return (await readdir(effectsDirectory)).filter(
                        (file) => file === 'effect-1.txt',
                    ).length
                } catch {
                    return 0
                }
            },
        },
        async dispose() {
            await rm(root, { recursive: true, force: true })
        },
    }
}

export function scoreCrashRecovery({ evalCase, fixture }) {
    const data = fixture.inspectors.result
    const events = data.resume?.events ?? []
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    const byId = new Map(results.map((event) => [event.data.toolCallId, event.data]))
    const counts = new Map()
    for (const result of results)
        counts.set(result.data.toolCallId, (counts.get(result.data.toolCallId) ?? 0) + 1)
    const unknown = results.filter((event) => event.data.outcome === 'unknown')
    const duplicateToolResultIds = [...counts].filter(([, count]) => count !== 1).map(([id]) => id)
    const unmatchedToolCallIds = calls.map((call) => call.id).filter((id) => !byId.has(id))
    const sequenceContinuous = events.every((event, index) => event.seq === index + 1)
    const protocolComplete =
        calls.every((call) => counts.get(call.id) === 1) &&
        results.every((event) => calls.some((call) => call.id === event.data.toolCallId))
    const resumed = Boolean(data.resume?.trace && data.resume?.requests?.length)
    const sideEffectExecutionCountAfterResume = data.resume?.executionCount ?? 0
    const details = {
        crashPhase: evalCase.name,
        persistedEventCountBeforeCrash: data.crash?.eventCount ?? null,
        recoveredEventCount: events.length,
        recoveredUnknownCount: unknown.length,
        duplicateToolResultIds,
        unmatchedToolCallIds,
        externalEffectCount: data.resume?.externalEffectCount ?? 0,
        sideEffectExecutionCountAfterResume,
        tornTailRecovered: evalCase.name === 'torn-tool-result-tail',
        sequenceContinuous,
        protocolComplete,
        resumed,
        stopReason: data.resume?.trace?.stopReason ?? null,
        recovered: resumed,
        noBlindRetry: sideEffectExecutionCountAfterResume === 0,
        rawLinesValid: data.resume?.rawLinesValid === true,
        doubleRestartIdempotent:
            evalCase.name !== 'crash-after-side-effect-start' ||
            (data.reopen?.events ?? []).filter((event) => event.type === 'tool/result').length ===
                1,
    }
    const expectedUnknown = [
        'crash-after-tool-call-commit',
        'crash-after-side-effect-start',
        'torn-tool-result-tail',
    ].includes(evalCase.name)
    const success =
        resumed &&
        protocolComplete &&
        sequenceContinuous &&
        details.rawLinesValid &&
        duplicateToolResultIds.length === 0 &&
        unmatchedToolCallIds.length === 0 &&
        details.noBlindRetry &&
        details.doubleRestartIdempotent &&
        (expectedUnknown ? unknown.length === 1 : unknown.length === 0)
    return {
        success,
        targetToolCalled: calls.length > 0,
        targetToolSucceeded: results.some((event) => !event.data.isError),
        details,
    }
}
