/**
 * Serializes complete Agent Runs per Session while allowing different
 * Sessions to execute concurrently.
 *
 * This is an in-process runtime primitive. It does not provide a distributed
 * lock for multiple mini-dsh processes sharing the same Session directory.
 */
export class SessionRunCoordinator {
    #queues = new Map()

    run(sessionId, task) {
        if (typeof task !== 'function') {
            throw new TypeError('SessionRunCoordinator task must be a function')
        }

        const previous = this.#queues.get(sessionId) ?? Promise.resolve()
        const current = previous.catch(() => {}).then(task)
        const tail = current.catch(() => {})

        this.#queues.set(sessionId, tail)
        current.then(
            () => this.#cleanup(sessionId, tail),
            () => this.#cleanup(sessionId, tail),
        )

        return current
    }

    pendingSessions() {
        return this.#queues.size
    }

    #cleanup(sessionId, tail) {
        if (this.#queues.get(sessionId) === tail) {
            this.#queues.delete(sessionId)
        }
    }
}
