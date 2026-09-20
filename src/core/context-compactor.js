const STRATEGY = 'deterministic-v1'
const BYTES_PER_TOKEN = 3
const MAX_SUMMARY_CHARS = 4096

/**
 * Creates a bounded, deterministic continuity note. It is intentionally not a
 * semantic or LLM-generated summary.
 */
export class DeterministicContextCompactor {
    compact({ events = [], previousSummary, context: _context, targetTokens } = {}) {
        const maxChars = summaryCharacterBudget(targetTokens)
        const sections = ['[Compacted session context: deterministic-v1]']
        const latestUser = events.findLast((event) => event.type === 'user/message')
        if (latestUser) {
            sections.push(`Latest user goal:\n${truncate(latestUser.data?.content, 800)}`)
        }
        if (previousSummary) {
            sections.push(`Previous compacted context:\n${truncate(previousSummary, 1200)}`)
        }

        const assistantText = events
            .filter(
                (event) =>
                    event.type === 'assistant/message' ||
                    (event.type === 'assistant/tool_calls' && event.data?.content),
            )
            .slice(-3)
            .map((event) => truncate(event.data?.content, 500))
        if (assistantText.length > 0) {
            sections.push(
                `Recent assistant text:\n${assistantText.map((text) => `- ${text}`).join('\n')}`,
            )
        }

        const toolLines = []
        for (const event of events) {
            if (event.type === 'assistant/tool_calls') {
                for (const call of event.data?.toolCalls ?? []) {
                    toolLines.push(
                        `- call ${call.name} ${truncate(stableJson(call.arguments ?? {}), 320)}`,
                    )
                }
            }
            if (event.type === 'tool/result') {
                const result = truncate(event.data?.content, 320, ' …[tool result truncated]')
                toolLines.push(
                    `- result ${event.data?.name ?? event.data?.toolCallId ?? 'tool'}: ${result}`,
                )
            }
        }
        if (toolLines.length > 0) {
            sections.push(`Tool activity:\n${toolLines.slice(-8).join('\n')}`)
        }

        return {
            summary: fitSections(sections, maxChars),
            strategy: STRATEGY,
            model: null,
        }
    }
}

function summaryCharacterBudget(targetTokens) {
    const targetChars = Number.isFinite(targetTokens)
        ? Math.floor(targetTokens * BYTES_PER_TOKEN * 0.4)
        : MAX_SUMMARY_CHARS
    return Math.max(256, Math.min(MAX_SUMMARY_CHARS, targetChars))
}

function fitSections(sections, maxChars) {
    let summary = ''
    for (const section of sections) {
        const separator = summary ? '\n\n' : ''
        const remaining = maxChars - summary.length - separator.length
        if (remaining <= 0) break
        summary += separator + truncate(section, remaining)
    }
    return summary
}

function truncate(value, maxChars, marker = ' …[truncated]') {
    const text = String(value ?? '')
    if (text.length <= maxChars) return text
    if (maxChars <= marker.length) return marker.slice(0, maxChars)
    return `${text.slice(0, maxChars - marker.length)}${marker}`
}

function stableJson(value) {
    return JSON.stringify(stableValue(value))
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stableValue(value[key])]),
    )
}
