export const name = 'mini-model-deepseek'
export const inject = ['llm']

export function apply(ctx, config = {}) {
    const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
    const baseUrl = (
        config.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        'https://api.deepseek.com'
    ).replace(/\/$/, '')

    const models = config.models ?? ['deepseek-v4-pro', 'deepseek-v4-flash']

    const thinking = config.thinking ?? process.env.DEEPSEEK_THINKING ?? 'enabled'

    const adapter = {
        models,

        async chat({ model, system, messages, tools, signal, onReasoning, onContent }) {
            if (!apiKey) {
                throw new Error(
                    'missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in',
                )
            }

            const body = {
                model,
                messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
                stream: true,
                thinking: {
                    type: thinking === 'disabled' ? 'disabled' : 'enabled',
                },
                stream_options: { include_usage: true },
                ...(tools?.length ? { tools } : {}),
            }

            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal,
            })

            if (!response.ok) {
                const text = await response.text()
                throw new Error(`DeepSeek API ${response.status}: ${text.slice(0, 2000)}`)
            }

            if (!response.body) {
                throw new Error('DeepSeek API returned no response body')
            }

            let content = ''
            let reasoningContent = ''
            let usage = null
            const toolCallsMap = new Map()

            for await (const event of parseSSE(response)) {
                if (event?.usage) usage = normalizeUsage(event.usage)
                const choice = event?.choices?.[0]
                if (!choice) continue
                const delta = choice.delta ?? {}

                if (delta.reasoning_content) {
                    reasoningContent += delta.reasoning_content
                    onReasoning?.(delta.reasoning_content)
                }

                if (delta.content) {
                    content += delta.content
                    onContent?.(delta.content)
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        accumulateToolCallDelta(toolCallsMap, tc)
                    }
                }
            }

            const toolCalls = finalizeToolCalls(toolCallsMap)

            return {
                content,
                reasoningContent: reasoningContent || undefined,
                toolCalls,
                usage,
            }
        },
    }

    // Provider registration is a reversible effect; unloading the plugin unregisters it.
    ctx.effect(
        () =>
            ctx.llm.register('deepseek', adapter, {
                defaultModel: process.env.MINI_DSH_MODEL?.startsWith('deepseek/')
                    ? process.env.MINI_DSH_MODEL.slice('deepseek/'.length)
                    : 'deepseek-v4-pro',
            }),
        'register deepseek provider',
    )
}

export function normalizeUsage(usage) {
    if (!usage) return null

    return {
        inputTokens: numberOrNull(usage.prompt_tokens),
        outputTokens: numberOrNull(usage.completion_tokens),
        reasoningTokens: numberOrNull(
            usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
        ),
        cacheHitTokens: numberOrNull(
            usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens,
        ),
        cacheMissTokens: numberOrNull(usage.prompt_cache_miss_tokens),
        cost: null,
    }
}

function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function* parseSSE(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

            const lines = buffer.split('\n')
            if (!done) buffer = lines.pop() ?? ''
            else buffer = ''

            for (const line of lines) {
                const event = parseSSELine(line)
                if (event === '[DONE]') return
                if (event) yield event
            }

            if (done) return
        }
    } finally {
        reader.releaseLock()
    }
}

function parseSSELine(line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return null
    if (!trimmed.startsWith('data:')) return null
    const dataStr = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed.slice(5).trim()
    if (dataStr === '[DONE]') return '[DONE]'
    try {
        return JSON.parse(dataStr)
    } catch {
        return null
    }
}

/**
 * Accumulate SSE delta.tool_calls into a map.
 *
 * The first chunk often already has the full function.name; start from
 * an empty string and concatenate, or names become read_fileread_file / bashbash.
 */
export function accumulateToolCallDelta(map, tc) {
    const index = tc.index ?? 0
    if (!map.has(index)) {
        map.set(index, { id: '', name: '', arguments: '' })
    }
    const target = map.get(index)
    if (tc.id) target.id = tc.id
    if (tc.function?.name) target.name += tc.function.name
    if (tc.function?.arguments) target.arguments += tc.function.arguments
    return target
}

export function finalizeToolCalls(map) {
    return [...map.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.name)
        .map((call) => ({
            id: call.id,
            name: call.name,
            arguments: parseToolArguments(call.arguments),
        }))
}

export function parseToolArguments(text) {
    if (!text) return {}
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(`incomplete tool arguments JSON: ${text}`)
    }
}
