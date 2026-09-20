export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4

/**
 * Partitions model tool calls into bounded parallel groups separated by
 * exclusive barriers. Policy decisions and durable events stay in AgentLoop.
 */
export class ToolScheduler {
    constructor({ tools, maxParallelToolCalls = DEFAULT_MAX_PARALLEL_TOOL_CALLS } = {}) {
        if (!tools || typeof tools.get !== 'function') {
            throw new TypeError('ToolScheduler requires tools.get()')
        }
        this.tools = tools
        this.maxParallelToolCalls = normalizeMaxParallelToolCalls(maxParallelToolCalls)
    }

    partition(toolCalls) {
        const groups = []
        let parallel = []

        const flushParallel = () => {
            if (parallel.length === 0) return
            groups.push({ type: 'parallel', calls: parallel })
            parallel = []
        }

        for (const [index, call] of toolCalls.entries()) {
            const entry = { index, call }
            if (this.tools.get(call.name)?.concurrencySafe === true) {
                parallel.push(entry)
                continue
            }

            flushParallel()
            groups.push({ type: 'exclusive', calls: [entry] })
        }
        flushParallel()
        return groups
    }

    async execute(toolCalls, { signal, run } = {}) {
        if (typeof run !== 'function') throw new TypeError('ToolScheduler.execute requires run()')

        const results = new Array(toolCalls.length)
        for (const group of this.partition(toolCalls)) {
            if (group.type === 'exclusive') {
                await this.#runEntry(group.calls[0], results, signal, run)
            } else {
                await this.#runParallel(group.calls, results, signal, run)
            }
        }
        return results
    }

    async #runParallel(entries, results, signal, run) {
        let cursor = 0
        const workerCount = Math.min(this.maxParallelToolCalls, entries.length)

        const worker = async () => {
            while (cursor < entries.length) {
                if (signal?.aborted) return
                const entry = entries[cursor]
                cursor += 1
                await this.#runEntry(entry, results, signal, run)
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => worker()))
        for (const entry of entries) {
            results[entry.index] ??= notStarted(entry, signal)
        }
    }

    async #runEntry(entry, results, signal, run) {
        if (signal?.aborted) {
            results[entry.index] = notStarted(entry, signal)
            return
        }
        results[entry.index] = await run(entry.call, {
            index: entry.index,
            signal,
        })
    }
}

export function normalizeMaxParallelToolCalls(value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError('maxParallelToolCalls must be a positive integer')
    }
    return value
}

export function maxParallelToolCallsFromEnv(env = process.env) {
    const value = env.MINI_DSH_MAX_PARALLEL_TOOL_CALLS
    if (value === undefined || String(value).trim() === '') {
        return DEFAULT_MAX_PARALLEL_TOOL_CALLS
    }
    return normalizeMaxParallelToolCalls(Number(value))
}

function notStarted(entry, signal) {
    return {
        index: entry.index,
        call: entry.call,
        state: 'not_started',
        stopReason: signal?.reason?.stopReason ?? 'cancelled',
    }
}
