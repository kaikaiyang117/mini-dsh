/** Pure Event Log -> provider message projection. */
export function projectSessionEvents(events) {
    const messages = []
    for (const event of events) {
        const { type, data } = event

        if (type === 'session/reset') {
            messages.length = 0
            continue
        }

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
