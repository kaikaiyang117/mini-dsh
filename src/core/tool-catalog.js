export class ToolCatalog {
    constructor({ tools } = {}) {
        if (!tools || typeof tools.list !== 'function') {
            throw new TypeError('ToolCatalog requires tools.list()')
        }
        this.tools = tools
    }

    snapshot() {
        const entries = this.tools.list().map(projectTool)
        return new ToolCatalogSnapshot(entries)
    }
}

export class ToolCatalogSnapshot {
    #entries

    constructor(entries) {
        this.#entries = Object.freeze(entries)
    }

    list() {
        return this.#entries
    }

    names() {
        return Object.freeze(this.#entries.map((entry) => entry.name))
    }

    view(names = this.names()) {
        if (!Array.isArray(names)) throw new TypeError('Tool selection must be an array of names')

        const selected = new Set(names)
        for (const name of selected) {
            if (typeof name !== 'string' || !this.#entries.some((entry) => entry.name === name)) {
                throw new Error(`unknown catalog tool: ${name}`)
            }
        }

        return new ToolView(this.#entries.filter((entry) => selected.has(entry.name)))
    }
}

export class ToolView {
    #entries

    constructor(entries) {
        this.#entries = Object.freeze(entries)
    }

    names() {
        return Object.freeze(this.#entries.map((entry) => entry.name))
    }

    list() {
        return this.#entries
    }

    has(name) {
        return this.#entries.some((entry) => entry.name === name)
    }

    schemas() {
        return this.#entries.map((entry) => ({
            type: 'function',
            function: {
                name: entry.name,
                description: entry.description,
                parameters: structuredClone(entry.parameters),
            },
        }))
    }
}

function projectTool(tool) {
    return deepFreeze({
        name: tool.name,
        description: tool.description ?? '',
        parameters: structuredClone(tool.parameters ?? { type: 'object' }),
        readOnly: tool.readOnly ?? false,
        idempotent: tool.idempotent ?? false,
        concurrencySafe: tool.concurrencySafe ?? false,
        sideEffect: tool.sideEffect ?? true,
        timeoutMs: tool.timeoutMs ?? null,
    })
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}
