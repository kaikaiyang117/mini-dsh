const MODEL_CONTEXT_EVENT_TYPES = new Set([
    'user/message',
    'assistant/message',
    'assistant/tool_calls',
    'tool/result',
])

/** Pure Event Log -> provider message projection. */
export function projectSessionEvents(events) {
    const resetSeq = latestResetSeq(events)
    const compaction = findLatestValidCompaction(events, resetSeq)
    const messages = compaction ? [{ role: 'system', content: compaction.data.summary }] : []
    const rawAfterSeq = compaction?.data.shadowedThroughSeq ?? resetSeq

    for (const event of events) {
        if (event.seq <= rawAfterSeq) continue
        const { type, data } = event

        if (type === 'user/message') {
            messages.push({ role: 'user', content: data.content })
        }

        if (type === 'assistant/message') {
            messages.push({ role: 'assistant', content: data.content })
        }

        if (type === 'assistant/tool_calls') {
            messages.push({
                role: 'assistant',
                content: data.content ?? null,
                ...(data.reasoningContent ? { reasoning_content: data.reasoningContent } : {}),
                tool_calls: data.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments ?? {}),
                    },
                })),
            })
        }

        if (type === 'tool/result') {
            messages.push({
                role: 'tool',
                tool_call_id: data.toolCallId,
                content: data.content,
            })
        }
    }
    return messages
}

export function findLatestValidCompaction(events, resetSeq = latestResetSeq(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event.seq <= resetSeq) break
        if (event.type !== 'context/compaction') continue
        if (isValidCompaction(events, event, resetSeq)) return event
    }
    return null
}

export function findProtocolSafeBoundaries(
    events,
    { afterSeq = 0, beforeSeq = Number.POSITIVE_INFINITY, resetSeq = latestResetSeq(events) } = {},
) {
    const boundaries = []
    const openToolCalls = new Set()

    for (const event of events) {
        if (event.seq <= resetSeq || event.seq >= beforeSeq) continue

        if (event.type === 'assistant/tool_calls') {
            for (const call of event.data?.toolCalls ?? []) openToolCalls.add(call.id)
        }
        if (event.type === 'tool/result') {
            openToolCalls.delete(event.data?.toolCallId)
        }

        if (
            event.seq > afterSeq &&
            MODEL_CONTEXT_EVENT_TYPES.has(event.type) &&
            openToolCalls.size === 0
        ) {
            boundaries.push(event.seq)
        }
    }
    return boundaries
}

export function latestResetSeq(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'session/reset') return events[index].seq
    }
    return 0
}

export function isModelContextEvent(event) {
    return MODEL_CONTEXT_EVENT_TYPES.has(event?.type)
}

function isValidCompaction(events, event, resetSeq) {
    const data = event.data ?? {}
    if (typeof data.summary !== 'string' || data.summary.length === 0) return false
    if (!Number.isInteger(data.shadowedFromSeq) || !Number.isInteger(data.shadowedThroughSeq)) {
        return false
    }
    if (
        data.shadowedFromSeq <= resetSeq ||
        data.shadowedThroughSeq < data.shadowedFromSeq ||
        data.shadowedThroughSeq >= event.seq
    ) {
        return false
    }
    return findProtocolSafeBoundaries(events, {
        afterSeq: data.shadowedThroughSeq - 1,
        beforeSeq: data.shadowedThroughSeq + 1,
        resetSeq,
    }).includes(data.shadowedThroughSeq)
}
