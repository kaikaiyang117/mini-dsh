/** Storage-only contract for append-only session event logs. */
export class SessionStore {
    async create() {
        throw new Error('SessionStore.create() is not implemented')
    }

    async open() {
        throw new Error('SessionStore.open() is not implemented')
    }

    async append() {
        throw new Error('SessionStore.append() is not implemented')
    }

    async flush() {
        throw new Error('SessionStore.flush() is not implemented')
    }

    async list() {
        throw new Error('SessionStore.list() is not implemented')
    }

    async close() {}
    async dispose() {}
}
