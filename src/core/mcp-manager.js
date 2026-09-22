export const MCP_STATES = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    ACTIVE: 'ACTIVE',
    FAILED: 'FAILED',
})

export const DEFAULT_MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * Owns MCP plugin instances without implementing the MCP protocol itself.
 * The injected activator is the only lifecycle bridge to the host framework.
 */
export class McpManager {
    #records = new Map()
    #activate
    #disposed = false
    #disposePromise = null

    constructor({ activate } = {}) {
        if (typeof activate !== 'function') {
            throw new TypeError('McpManager requires activate(definition)')
        }
        this.#activate = activate
    }

    register(definition) {
        this.#assertOpen()
        const normalized = normalizeDefinition(definition)
        if (this.#records.has(normalized.name)) {
            throw new Error(`duplicate MCP server name: ${normalized.name}`)
        }

        const record = {
            definition: normalized,
            state: MCP_STATES.DISCONNECTED,
            lastError: null,
            fiber: null,
            tail: null,
            removing: false,
        }
        this.#records.set(normalized.name, record)

        let unregistering = null
        return () => {
            if (!unregistering) {
                unregistering = this.unregister(normalized.name).catch((error) => {
                    unregistering = null
                    throw error
                })
            }
            return unregistering
        }
    }

    list() {
        return [...this.#records.values()].map((record) => snapshot(record))
    }

    get(name) {
        const record = this.#records.get(name)
        return record ? snapshot(record) : undefined
    }

    async connect(name) {
        this.#assertOpen()
        const record = this.#require(name)
        this.#assertNotRemoving(record)
        return this.#enqueue(record, () => this.#connectUnlocked(record))
    }

    async disconnect(name) {
        this.#assertOpen()
        const record = this.#require(name)
        this.#assertNotRemoving(record)
        return this.#enqueue(record, () => this.#disconnectUnlocked(record))
    }

    async reload(name) {
        this.#assertOpen()
        const record = this.#require(name)
        this.#assertNotRemoving(record)
        return this.#enqueue(record, async () => {
            await this.#disconnectUnlocked(record)
            return this.#connectUnlocked(record)
        })
    }

    async startAuto() {
        this.#assertOpen()
        const records = [...this.#records.values()].filter((record) => record.definition.autoStart)
        return Promise.all(
            records.map(async (record) => {
                try {
                    return await this.connect(record.definition.name)
                } catch {
                    return snapshot(record)
                }
            }),
        )
    }

    async unregister(name) {
        this.#assertOpen()
        const record = this.#records.get(name)
        if (!record) return
        record.removing = true
        try {
            await this.#enqueue(record, () => this.#disconnectUnlocked(record))
        } catch (error) {
            record.removing = false
            throw error
        }
        if (this.#records.get(name) === record) this.#records.delete(name)
    }

    async dispose() {
        if (this.#disposed) return
        if (this.#disposePromise) return this.#disposePromise

        const records = [...this.#records.values()]
        const shutdown = Promise.allSettled(
            records.map((record) => this.#enqueue(record, () => this.#disconnectUnlocked(record))),
        ).then((results) => {
            const failure = results.find((result) => result.status === 'rejected')
            if (failure) throw failure.reason
            this.#records.clear()
            this.#disposed = true
        })

        this.#disposePromise = shutdown.catch((error) => {
            this.#disposePromise = null
            throw error
        })
        return this.#disposePromise
    }

    #enqueue(record, operation) {
        const previous = record.tail ?? Promise.resolve()
        const current = previous.catch(() => {}).then(operation)
        const tail = current.catch(() => {})
        record.tail = tail
        current.then(
            () => this.#cleanup(record, tail),
            () => this.#cleanup(record, tail),
        )
        return current
    }

    #cleanup(record, tail) {
        if (record.tail === tail) record.tail = null
    }

    async #connectUnlocked(record) {
        if (record.state === MCP_STATES.ACTIVE) return snapshot(record)

        if (record.fiber) await this.#disconnectUnlocked(record)

        record.state = MCP_STATES.CONNECTING
        record.lastError = null
        try {
            const fiber = await this.#activate(record.definition)
            if (!fiber || typeof fiber.dispose !== 'function') {
                throw new TypeError('MCP activator must return { dispose() }')
            }
            record.fiber = fiber
            record.state = MCP_STATES.ACTIVE
            return snapshot(record)
        } catch (error) {
            record.fiber = null
            record.state = MCP_STATES.FAILED
            record.lastError = error
            throw error
        }
    }

    async #disconnectUnlocked(record) {
        const fiber = record.fiber
        if (!fiber) {
            record.state = MCP_STATES.DISCONNECTED
            record.lastError = null
            return snapshot(record)
        }
        try {
            await fiber.dispose()
            record.fiber = null
            record.state = MCP_STATES.DISCONNECTED
            record.lastError = null
        } catch (error) {
            record.state = MCP_STATES.FAILED
            record.lastError = error
            throw error
        }
        return snapshot(record)
    }

    #require(name) {
        const record = this.#records.get(name)
        if (!record) throw new Error(`unknown MCP server: ${name}`)
        return record
    }

    #assertOpen() {
        if (this.#disposed || this.#disposePromise) {
            throw new Error('McpManager is disposing or disposed')
        }
    }

    #assertNotRemoving(record) {
        if (record.removing)
            throw new Error(`MCP server is being removed: ${record.definition.name}`)
    }
}

function normalizeDefinition(definition) {
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('MCP server definition is required')
    }
    if (typeof definition.name !== 'string' || !definition.name.trim()) {
        throw new TypeError('MCP server name is required')
    }
    if (definition.autoStart !== undefined && typeof definition.autoStart !== 'boolean') {
        throw new TypeError('MCP server autoStart must be a boolean')
    }
    if (
        definition.config !== undefined &&
        (definition.config === null ||
            typeof definition.config !== 'object' ||
            Array.isArray(definition.config))
    ) {
        throw new TypeError('MCP server config must be an object')
    }

    const name = definition.name.trim()
    const config = { ...(definition.config ?? {}) }
    if (config.serverName !== undefined && config.serverName !== name) {
        throw new TypeError('MCP config.serverName must match the registered name')
    }
    config.serverName = name

    return {
        name,
        package: definition.package ?? DEFAULT_MCP_PACKAGE,
        config,
        autoStart: definition.autoStart ?? false,
    }
}

function snapshot(record) {
    return {
        name: record.definition.name,
        package: record.definition.package,
        autoStart: record.definition.autoStart,
        state: record.state,
        lastError: record.lastError ? errorSnapshot(record.lastError) : null,
    }
}

function errorSnapshot(error) {
    return {
        name: error?.name ?? 'Error',
        message: redactText(error?.message ?? String(error)),
    }
}

function redactText(value) {
    return String(value)
        .replace(/(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/(api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/([?&](?:api[-_]?key|token|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
}
