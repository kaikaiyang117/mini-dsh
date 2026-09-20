import { randomUUID } from 'node:crypto'
import { projectSessionEvents } from './context-manager.js'
import { MemorySessionStore } from './memory-session-store.js'

const INTERRUPTED_TOOL_MESSAGE =
    'Interrupted tool call; actual outcome is unknown. The tool was not retried automatically.'

/**
 * Session semantics live here. Stores only persist opaque session records and
 * events; they never interpret assistant, tool, or message event types.
 */
export class SessionRuntime {
    #store
    #sessions = new Map()
    #appendQueues = new Map()
    #now

    constructor({ store = new MemorySessionStore(), now = () => new Date().toISOString() } = {}) {
        this.#store = store
        this.#now = now
    }

    async create(meta = {}) {
        const session = {
            id: randomUUID(),
            meta: { ...meta },
            events: [],
            createdAt: this.#now(),
        }
        await this.#store.create({
            id: session.id,
            meta: session.meta,
            createdAt: session.createdAt,
        })
        this.#sessions.set(session.id, session)
        await this.append(session.id, 'session/start', { meta: session.meta })
        return session
    }

    async open(id) {
        const cached = this.#sessions.get(id)
        if (cached) return cached

        const stored = await this.#store.open(id)
        const start = stored.events.find((event) => event.type === 'session/start')
        const session = {
            id: stored.id,
            meta: { ...(start?.data?.meta ?? stored.meta ?? {}) },
            events: stored.events.map((event) => ({ ...event })),
            createdAt: stored.createdAt ?? start?.at ?? null,
        }
        this.#sessions.set(id, session)
        await this.#recoverInterruptedToolCalls(session)
        return session
    }

    get(id) {
        const session = this.#sessions.get(id)
        if (!session) throw new Error(`Session ${id} is not open`)
        return session
    }

    async append(id, type, data) {
        const append = async () => {
            const session = this.get(id)
            const event = {
                seq: session.events.length + 1,
                type,
                data,
                at: this.#now(),
            }
            await this.#store.append(id, event)
            session.events.push(event)
            return event
        }
        const previous = this.#appendQueues.get(id) ?? Promise.resolve()
        const next = previous.then(append, append)
        this.#appendQueues.set(
            id,
            next.catch(() => {}),
        )
        return next
    }

    async reset(id) {
        const session = this.get(id)
        await this.append(id, 'session/reset', { meta: session.meta })
        return session
    }

    async clear(id) {
        return this.reset(id)
    }

    async list() {
        const records = await this.#store.list()
        return records.map((record) => {
            const events = record.events ?? []
            const start = events.find((event) => event.type === 'session/start')
            return {
                id: record.id,
                meta: { ...(start?.data?.meta ?? record.meta ?? {}) },
                createdAt: record.createdAt ?? events[0]?.at ?? null,
                updatedAt: record.updatedAt ?? events.at(-1)?.at ?? null,
                eventCount: record.eventCount ?? events.length,
            }
        })
    }

    async flush(id) {
        await this.#store.flush(id)
    }

    async close(id) {
        await this.#appendQueues.get(id)
        await this.#store.close(id)
        this.#sessions.delete(id)
        this.#appendQueues.delete(id)
    }

    async dispose() {
        await Promise.all([...this.#appendQueues.values()])
        await this.#store.dispose()
        this.#sessions.clear()
        this.#appendQueues.clear()
    }

    /** Legacy compatibility projection. AgentLoop uses ContextManager directly. */
    deriveMessages(id) {
        return projectSessionEvents(this.get(id).events)
    }

    async #recoverInterruptedToolCalls(session) {
        const answered = new Set(
            session.events
                .filter((event) => event.type === 'tool/result')
                .map((event) => event.data?.toolCallId),
        )
        const missing = []
        for (const event of session.events) {
            if (event.type !== 'assistant/tool_calls') continue
            for (const call of event.data?.toolCalls ?? []) {
                if (!answered.has(call.id)) {
                    answered.add(call.id)
                    missing.push({ call, event })
                }
            }
        }

        for (const { call, event } of missing) {
            await this.append(session.id, 'tool/result', {
                toolCallId: call.id,
                name: call.name,
                isError: true,
                errorCode: null,
                content: INTERRUPTED_TOOL_MESSAGE,
                outcome: 'unknown',
                recovered: true,
                retryable: false,
                runId: event.data.runId,
                stepId: event.data.stepId,
            })
        }
    }
}
