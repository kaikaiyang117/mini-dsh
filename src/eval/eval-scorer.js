export function resolveExpectation(expected, variant) {
    if (!expected || typeof expected !== 'object') return null
    if (expected.completion === 'stop-reason') {
        return {
            completion: 'stop-reason',
            stopReason:
                typeof expected.stopReason === 'string'
                    ? expected.stopReason
                    : (expected.stopReason?.[variant] ?? null),
        }
    }
    return { completion: 'target-tool', targetTool: expected.targetTool ?? null }
}

export function targetToolScorer({ trace, expected }) {
    const matchingCalls = (trace?.steps ?? [])
        .flatMap((step) => step.toolCalls ?? [])
        .filter((toolCall) => toolCall.name === expected?.targetTool)
    const targetToolCalled = matchingCalls.length > 0
    const targetToolSucceeded = matchingCalls.some((toolCall) => toolCall.status === 'completed')
    return {
        success: targetToolSucceeded,
        targetToolCalled,
        targetToolSucceeded,
        details: { expectedTool: expected?.targetTool, targetToolCalled, targetToolSucceeded },
    }
}

export function stopReasonScorer({ trace, expected, variant }) {
    const resolved = resolveExpectation(expected, variant)
    return {
        success: trace?.stopReason === resolved?.stopReason,
        targetToolCalled: false,
        targetToolSucceeded: false,
        details: {
            expectedStopReason: resolved?.stopReason,
            actualStopReason: trace?.stopReason ?? null,
        },
    }
}

export function completionScorer(input) {
    const resolved = resolveExpectation(input.expected, input.variant)
    return resolved?.completion === 'stop-reason'
        ? stopReasonScorer(input)
        : targetToolScorer({ ...input, expected: resolved })
}

// Backward compatible export retained for existing eval consumers.
export const evalCompletionScorer = completionScorer
export function targetToolCalledScorer(trace, expected = {}) {
    const { details, ...result } = targetToolScorer({ trace, expected })
    return result
}
