import { Service } from '@deepseek-ai/cordis'
import { JsonlSessionStore } from '../core/jsonl-session-store.js'
import { MemorySessionStore } from '../core/memory-session-store.js'
import { SessionRuntime } from '../core/session-runtime.js'

class SessionsService extends Service {
    constructor(ctx, config) {
        super(ctx, 'sessions')
        const store =
            config.store ??
            (config.directory
                ? new JsonlSessionStore({ directory: config.directory })
                : new MemorySessionStore())
        this.runtime = new SessionRuntime({ store })
    }

    create(meta) {
        return this.runtime.create(meta)
    }

    open(id) {
        return this.runtime.open(id)
    }

    get(id) {
        return this.runtime.get(id)
    }

    append(id, type, data) {
        return this.runtime.append(id, type, data)
    }

    clear(id) {
        return this.runtime.clear(id)
    }

    reset(id) {
        return this.runtime.reset(id)
    }

    list() {
        return this.runtime.list()
    }

    flush(id) {
        return this.runtime.flush(id)
    }

    close(id) {
        return this.runtime.close(id)
    }

    dispose() {
        return this.runtime.dispose()
    }

    deriveMessages(id) {
        return this.runtime.deriveMessages(id)
    }
}

export const name = 'mini-sessions'
export function apply(ctx, config = {}) {
    ctx.plugin(
        class ConfiguredSessionsService extends SessionsService {
            constructor(serviceContext) {
                super(serviceContext, config)
            }
        },
    )
}
