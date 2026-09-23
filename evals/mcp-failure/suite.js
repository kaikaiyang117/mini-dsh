import { EvalSuite } from '../../src/eval/eval-suite.js'
import { MCP_FAILURE_CASES } from './cases.js'
import { createMcpFailureFixture } from './fixture.js'

export function createMcpFailureSuite() {
    return new EvalSuite({
        name: 'mcp-failure-lifecycle',
        cases: MCP_FAILURE_CASES,
        variants: ['default'],
        fixtureFactory: createMcpFailureFixture,
        scorer: scoreMcpFailure,
        assertions: [
            ({ report }) => {
                for (const result of report.results) {
                    if (!result.success)
                        throw new Error(
                            `${result.caseName} must satisfy its MCP lifecycle contract`,
                        )
                }
            },
        ],
        reporter: (report) => ({
            headers: ['case', 'success', 'states', 'tools', 'tool failures', 'protocol', 'leaks'],
            rows: report.results.map((result) => [
                result.caseName,
                result.success,
                Object.entries(result.scoreDetails.serverStates ?? {})
                    .map(
                        ([name, state]) =>
                            `${name}:${typeof state === 'string' ? state : JSON.stringify(state)}`,
                    )
                    .join(', '),
                (result.scoreDetails.registeredToolNames ?? []).join(', ') || 'none',
                result.scoreDetails.toolFailures,
                result.scoreDetails.protocolComplete,
                result.scoreDetails.toolLeakCount,
            ]),
        }),
    })
}

export function scoreMcpFailure({ evalCase, fixture, trace }) {
    const state = fixture.inspectors
    const result = state.result ?? {}
    const events = result.events ?? []
    const calls = events
        .filter((event) => event.type === 'assistant/tool_calls')
        .flatMap((event) => event.data.toolCalls ?? [])
    const results = events.filter((event) => event.type === 'tool/result')
    const counts = new Map()
    for (const event of results)
        counts.set(event.data.toolCallId, (counts.get(event.data.toolCallId) ?? 0) + 1)
    const duplicateToolResultIds = [...counts].filter(([, count]) => count !== 1).map(([id]) => id)
    const unmatchedToolCallIds = calls.map((call) => call.id).filter((id) => !counts.has(id))
    const protocolComplete =
        result.protocolComplete ??
        (calls.every((call) => counts.get(call.id) === 1) &&
            results.every((event) => calls.some((call) => call.id === event.data.toolCallId)))
    const toolFailures = results.filter((event) => event.data.isError).length
    const registeredToolNames = state.registeredToolNames ?? []
    const expectedToolNames =
        {
            'mixed-server-isolation': ['mcp__fake__echo'],
            'reload-restores-tools': ['mcp__fake__echo'],
            'active-plugin-tool-execution-failure': ['mcp__unstable__query'],
            'reload-cleanup-failure': ['mcp__reload-cleanup-failure__tool'],
        }[evalCase.name] ?? []
    const details = {
        serverStates: state.serverStates ?? {},
        activationAttempts: state.activationAttempts ?? 0,
        disposalAttempts: state.disposalAttempts ?? 0,
        errorRedacted: state.errorRedacted ?? false,
        registeredToolNames,
        registeredToolNamesAfterFirstDispose: state.registeredToolNamesAfterFirstDispose ?? [],
        toolLeakCount: registeredToolNames.filter((name) => !expectedToolNames.includes(name))
            .length,
        toolCallCount: calls.length,
        toolResultCount: results.length,
        toolFailures,
        duplicateToolResultIds,
        unmatchedToolCallIds,
        protocolComplete,
        healthyServerUsable: state.healthyServerUsable ?? false,
        brokenToolAbsent: state.brokenToolAbsent ?? false,
        staleToolReturnedUnknown: state.staleToolReturnedUnknown ?? false,
        staleSchemaVisible: state.staleSchemaVisible ?? false,
        toolErrorCode: state.toolErrorCode ?? null,
        toolIsError: state.toolIsError ?? false,
        toolFailure: state.toolFailure ?? null,
        modelSawToolFailure: state.modelSawToolFailure ?? false,
        managerStateAfterToolFailure: state.serverStates?.unstable ?? null,
        cleanupRetried: state.cleanupRetried ?? false,
        reloadCreatedNewFiber: state.reloadCreatedNewFiber ?? false,
        oldToolRetained: state.oldToolRetained ?? false,
        toolRegistrationCount: state.toolRegistrationCount ?? 0,
        finalManagerDisposed: state.finalManagerDisposed ?? false,
        stopReason: trace?.stopReason ?? 'completed',
    }
    const success = caseSuccess(evalCase.name, details)
    return {
        success,
        targetToolCalled: calls.length > 0,
        targetToolSucceeded: results.some((event) => !event.data.isError),
        details,
    }
}

function caseSuccess(name, details) {
    if (name === 'activation-failure-cleanup')
        return (
            details.serverStates.broken === 'FAILED' &&
            !details.registeredToolNames.includes('mcp__broken__partial') &&
            details.toolLeakCount === 0 &&
            details.errorRedacted
        )
    if (name === 'mixed-server-isolation')
        return (
            details.serverStates.broken === 'FAILED' &&
            details.serverStates.fake === 'ACTIVE' &&
            details.healthyServerUsable &&
            details.registeredToolNames.includes('mcp__fake__echo') &&
            details.brokenToolAbsent &&
            details.toolLeakCount === 0
        )
    if (name === 'disconnect-removes-tools')
        return (
            details.serverStates.fake === 'DISCONNECTED' &&
            details.healthyServerUsable &&
            details.staleToolReturnedUnknown &&
            details.toolErrorCode === 'unknown_tool' &&
            !details.registeredToolNames.includes('mcp__fake__echo') &&
            details.toolLeakCount === 0
        )
    if (name === 'reload-restores-tools')
        return (
            details.serverStates.fake === 'ACTIVE' &&
            details.healthyServerUsable &&
            details.registeredToolNames.filter((name) => name === 'mcp__fake__echo').length === 1 &&
            details.toolRegistrationCount === 1 &&
            details.reloadCreatedNewFiber &&
            details.toolLeakCount === 0
        )
    if (name === 'stale-schema-after-disconnect')
        return (
            details.staleSchemaVisible &&
            details.staleToolReturnedUnknown &&
            details.toolErrorCode === 'unknown_tool' &&
            details.modelSawToolFailure &&
            details.protocolComplete &&
            details.stopReason === 'completed' &&
            details.toolLeakCount === 0
        )
    if (name === 'active-plugin-tool-execution-failure')
        return (
            details.managerStateAfterToolFailure === 'ACTIVE' &&
            details.toolFailures === 1 &&
            details.toolErrorCode === 'execution_error' &&
            details.toolIsError &&
            String(details.toolFailure).includes('remote MCP unavailable') &&
            details.modelSawToolFailure &&
            details.protocolComplete &&
            details.stopReason === 'completed' &&
            details.toolLeakCount === 0
        )
    if (name === 'cleanup-failure-retry')
        return (
            details.serverStates.first === 'FAILED' &&
            details.serverStates.second === 'DISCONNECTED' &&
            details.cleanupRetried &&
            details.registeredToolNames.length === 0 &&
            details.toolLeakCount === 0
        )
    if (name === 'reload-cleanup-failure')
        return (
            details.serverStates.first === 'FAILED' &&
            details.activationAttempts === 1 &&
            details.reloadCreatedNewFiber === false &&
            details.oldToolRetained &&
            details.toolRegistrationCount === 1
        )
    if (name === 'manager-dispose-partial-failure')
        return (
            details.serverStates.afterFirstDispose?.['server-a'] === 'DISCONNECTED' &&
            details.serverStates.afterFirstDispose?.['server-b'] === 'FAILED' &&
            details.registeredToolNamesAfterFirstDispose?.length === 1 &&
            details.cleanupRetried &&
            details.finalManagerDisposed &&
            details.registeredToolNames.length === 0 &&
            details.toolLeakCount === 0
        )
    return false
}
