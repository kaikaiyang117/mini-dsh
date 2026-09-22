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
