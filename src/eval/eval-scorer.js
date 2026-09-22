export function targetToolCalledScorer(trace, expected = {}) {
    const targetTool = expected.targetTool
    const matchingCalls = (trace?.steps ?? [])
        .flatMap((step) => step.toolCalls ?? [])
        .filter((toolCall) => toolCall.name === targetTool)

    return {
        targetToolCalled: matchingCalls.length > 0,
        targetToolSucceeded: matchingCalls.some((toolCall) => toolCall.status === 'completed'),
        success: matchingCalls.some((toolCall) => toolCall.status === 'completed'),
    }
}

export function evalCompletionScorer(trace, expected = {}, variant) {
    if (expected.completion === 'stop-reason') {
        const expectedStopReason =
            typeof expected.stopReason === 'string'
                ? expected.stopReason
                : expected.stopReason?.[variant]
        return {
            targetToolCalled: false,
            targetToolSucceeded: false,
            success: trace?.stopReason === expectedStopReason,
        }
    }
    return targetToolCalledScorer(trace, expected)
}
