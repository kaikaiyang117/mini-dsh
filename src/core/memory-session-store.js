import { SessionStore } from './session-store.js'

export class MemorySessionStore extends SessionStore {
    #sessions = new Map()

    async create(record) {
        if (this.#sessions.has(record.id)) throw new Error(`Session ${record.id} already exists`)
        this.#sessions.set(record.id, {
            id: record.id,
            meta: { ...(record.meta ?? {}) },
            createdAt: record.createdAt ?? null,
            events: [],
        })
    }

    async open(id) {
        const session = this.#sessions.get(id)
        if (!session) throw new Error(`Session ${id} not found`)
        return cloneSession(session)
    }

    async append(id, event) {
        const session = this.#sessions.get(id)
        if (!session) throw new Error(`Session ${id} not found`)
        const expected = session.events.length + 1
        if (event.seq !== expected) {
            throw new Error(`Session ${id} sequence gap: expected ${expected}, got ${event.seq}`)
        }
        session.events.push({ ...event, data: structuredClone(event.data) })
    }

    async list() {
        return [...this.#sessions.values()].map(cloneSession)
    }

    async close() {}
    async dispose() {
        this.#sessions.clear()
    }
}

function cloneSession(session) {
    return {
        ...session,
        meta: { ...session.meta },
        events: session.events.map((event) => ({
            ...event,
            data: structuredClone(event.data),
        })),
    }
}
