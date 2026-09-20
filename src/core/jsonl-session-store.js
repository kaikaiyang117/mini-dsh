import { randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readdir, readFile, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readJsonlWithRecovery, SessionCorruptionError } from './session-recovery.js'
import { SessionStore } from './session-store.js'

export { SessionCorruptionError } from './session-recovery.js'

const SESSION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class JsonlSessionStore extends SessionStore {
    #directory
    #fileSystem
    #sessions = new Map()
    #queues = new Map()

    constructor({ directory = '.data/sessions', fileSystem = {} } = {}) {
        super()
        this.#directory = path.resolve(directory)
        this.#fileSystem = {
            mkdir,
            open: openFile,
            readdir,
            readFile,
            writeFile,
            truncate,
            ...fileSystem,
        }
    }

    async create(record = {}) {
        const id = validateSessionId(record.id ?? randomUUID())
        await this.#fileSystem.mkdir(this.#directory, { recursive: true })
        const directory = this.#sessionDirectory(id)
        await this.#fileSystem.mkdir(directory, { recursive: false })
        await this.#fileSystem.writeFile(this.#sessionFile(id), Buffer.alloc(0), { flag: 'wx' })
        this.#sessions.set(id, {
            id,
            meta: { ...(record.meta ?? {}) },
            createdAt: record.createdAt ?? null,
            lastSeq: 0,
        })
        return { id }
    }

    async open(id) {
        id = validateSessionId(id)
        await this.#waitForWrites(id)
        const events = await readJsonlWithRecovery(this.#sessionFile(id), this.#fileSystem)
        const record = {
            id,
            meta: {},
            createdAt: null,
            lastSeq: events.length,
        }
        this.#sessions.set(id, record)
        return {
            id,
            meta: null,
            createdAt: null,
            events,
        }
    }

    async append(id, event) {
        id = validateSessionId(id)
        return this.#enqueue(id, async () => {
            const record = this.#sessions.get(id) ?? (await this.#loadRecord(id))
            const expected = record.lastSeq + 1
            if (event.seq !== expected) {
                throw new SessionCorruptionError(
                    `Session sequence gap: expected ${expected}, got ${event.seq}`,
                )
            }
            const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')
            await this.#fileSystem.writeFile(this.#sessionFile(id), bytes, { flag: 'a' })
            record.lastSeq = event.seq
            this.#sessions.set(id, record)
            return event
        })
    }

    async flush(id) {
        if (id !== undefined) {
            id = validateSessionId(id)
            await this.#waitForWrites(id)
            await this.#sync(id)
            return
        }
        await Promise.all([...this.#sessions.keys()].map((sessionId) => this.flush(sessionId)))
    }

    async list() {
        await this.#fileSystem.mkdir(this.#directory, { recursive: true })
        const entries = await this.#fileSystem.readdir(this.#directory, { withFileTypes: true })
        const sessions = []
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            sessions.push(await this.open(validateSessionId(entry.name)))
        }
        return sessions
    }

    async close(id) {
        if (id === undefined) {
            await this.flush()
            this.#sessions.clear()
            return
        }
        id = validateSessionId(id)
        await this.flush(id)
        this.#sessions.delete(id)
    }

    async dispose() {
        await this.close()
        this.#queues.clear()
    }

    #sessionDirectory(id) {
        return path.join(this.#directory, validateSessionId(id))
    }

    #sessionFile(id) {
        return path.join(this.#sessionDirectory(id), 'session.jsonl')
    }

    async #loadRecord(id) {
        const record = await this.open(id)
        return this.#sessions.get(record.id)
    }

    #enqueue(id, operation) {
        const previous = this.#queues.get(id) ?? Promise.resolve()
        const next = previous.then(operation, operation)
        this.#queues.set(
            id,
            next.catch(() => {}),
        )
        return next
    }

    async #waitForWrites(id) {
        await this.#queues.get(id)
    }

    async #sync(id) {
        const handle = await this.#fileSystem.open(this.#sessionFile(id), 'r+')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    }
}

export function validateSessionId(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id) || path.basename(id) !== id) {
        throw new TypeError(`unsafe session id: ${String(id)}`)
    }
    return id
}
