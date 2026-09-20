import Ajv from 'ajv'

const DEFAULT_PARAMETERS = Object.freeze({ type: 'object' })
const DEFAULT_METADATA = Object.freeze({
    timeoutMs: null,
    readOnly: false,
    idempotent: false,
    concurrencySafe: false,
    sideEffect: true,
})

const ERROR_CODES = Object.freeze({
    UNKNOWN_TOOL: 'unknown_tool',
    INVALID_ARGUMENTS: 'invalid_arguments',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    EXECUTION_ERROR: 'execution_error',
})

function toText(value) {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2)
}

function blocksToText(blocks) {
    if (!Array.isArray(blocks)) return toText(blocks)
    return blocks
        .map((block) => (block?.type === 'text' ? (block.text ?? '') : toText(block)))
        .filter(Boolean)
        .join('\n')
}

/**
 * In-memory Tool Runtime V2.
 *
 * Tool definitions are normalized and their JSON Schema validators are
 * compiled once at registration. Execution always returns a stable result;
 * validation, timeout, cancellation, and tool failures are data outcomes.
 */
export class ToolRuntime {
    #tools = new Map()
    #ajv
    #now

    constructor({ now = () => Date.now(), ajv } = {}) {
        this.#ajv =
            ajv ??
            new Ajv({
                allErrors: true,
                strict: false,
                coerceTypes: false,
                removeAdditional: false,
            })
        this.#now = now
    }

    register(definition) {
        if (!definition?.name) throw new Error('tool.name is required')
        if (typeof definition.execute !== 'function')
            throw new Error(`tool is missing execute(): ${definition.name}`)
        if (this.#tools.has(definition.name))
            throw new Error(`duplicate tool name: ${definition.name}`)

        const normalized = normalizeDefinition(definition)
        const validate = this.#ajv.compile(normalized.parameters)
        const record = { definition: normalized, validate }
        this.#tools.set(normalized.name, record)

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (this.#tools.get(normalized.name) === record) this.#tools.delete(normalized.name)
        }
    }

    get(name) {
        return this.#tools.get(name)?.definition
    }

    list() {
        return [...this.#tools.values()].map(({ definition }) => definition)
    }

    schemas() {
        return this.list().map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.parameters,
            },
        }))
    }

    async execute(name, args, exec = {}) {
        const startedAt = this.#now()
        const record = this.#tools.get(name)
        if (!record) {
            return errorResult(
                null,
                [{ type: 'text', text: `Unknown tool: ${name}` }],
                ERROR_CODES.UNKNOWN_TOOL,
                metadata(this.#now() - startedAt),
            )
        }

        const { definition, validate } = record
        const parentSignal = exec.signal
        if (parentSignal?.aborted) {
            return errorResult(
                null,
                [{ type: 'text', text: 'Tool cancelled before execution' }],
                ERROR_CODES.CANCELLED,
                metadata(this.#now() - startedAt, { cancelled: true }),
            )
        }

        if (!validate(args)) {
            return errorResult(
                null,
                [{ type: 'text', text: formatValidationError(validate.errors) }],
                ERROR_CODES.INVALID_ARGUMENTS,
                metadata(this.#now() - startedAt),
            )
        }

        const timeout = createTimeout(definition.timeoutMs)
        const signal = combineSignals(parentSignal, timeout.signal)
        const execution = {
            signal: signal ?? new AbortController().signal,
            sessionId: exec.sessionId,
            toolCallId: exec.toolCallId,
            agent: exec.agent,
        }

        try {
            // Parent cancellation is delivered through execution.signal. The
            // tool may finish a synchronous side effect after requesting
            // parent cancellation; only the Tool Runtime timeout races the
            // promise itself. A parent abort is still classified as
            // cancelled when the tool rejects or observes the signal.
            const value = await abortable(definition.execute(args, execution), timeout.signal)
            const content = definition.output?.render
                ? await definition.output.render(args, value)
                : [{ type: 'text', text: toText(value) }]

            let result = {
                value,
                content,
                isError: false,
                errorCode: null,
                metadata: metadata(this.#now() - startedAt),
            }
            if (typeof definition.finalizeContent === 'function') {
                const finalized = await definition.finalizeContent(execution, result)
                if (finalized !== undefined) result = { ...result, content: finalized }
            }
            return result
        } catch (error) {
            const errorCode = classifyAbort(error, parentSignal, timeout.signal)
            const isCancelled = errorCode === ERROR_CODES.CANCELLED
            const isTimeout = errorCode === ERROR_CODES.TIMEOUT
            return errorResult(
                null,
                [{ type: 'text', text: `ToolError: ${error?.message ?? String(error)}` }],
                errorCode,
                metadata(this.#now() - startedAt, {
                    timeout: isTimeout,
                    cancelled: isCancelled,
                }),
            )
        } finally {
            timeout.dispose()
        }
    }

    renderResult(result) {
        return blocksToText(result.content)
    }
}

function normalizeDefinition(definition) {
    const metadata = {
        ...DEFAULT_METADATA,
        timeoutMs: definition.timeoutMs ?? DEFAULT_METADATA.timeoutMs,
        readOnly: definition.readOnly ?? DEFAULT_METADATA.readOnly,
        idempotent: definition.idempotent ?? DEFAULT_METADATA.idempotent,
        concurrencySafe: definition.concurrencySafe ?? DEFAULT_METADATA.concurrencySafe,
        sideEffect: definition.sideEffect ?? DEFAULT_METADATA.sideEffect,
    }
    if (
        metadata.timeoutMs !== null &&
        (typeof metadata.timeoutMs !== 'number' ||
            !Number.isFinite(metadata.timeoutMs) ||
            metadata.timeoutMs < 0)
    ) {
        throw new TypeError('tool.timeoutMs must be null or a non-negative finite number')
    }

    return {
        ...definition,
        ...metadata,
        parameters: definition.parameters ?? DEFAULT_PARAMETERS,
    }
}

function metadata(durationMs, overrides = {}) {
    return {
        durationMs: Math.max(0, durationMs),
        timeout: false,
        cancelled: false,
        ...overrides,
    }
}

function errorResult(value, content, errorCode, resultMetadata) {
    return {
        value,
        content,
        isError: true,
        errorCode,
        metadata: resultMetadata,
    }
}

function formatValidationError(errors = []) {
    return errors
        .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
        .join('; ')
}

function createTimeout(timeoutMs) {
    if (timeoutMs === null) return { signal: null, dispose() {} }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort({ errorCode: ERROR_CODES.TIMEOUT }), timeoutMs)
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer)
        },
    }
}

function combineSignals(parentSignal, timeoutSignal) {
    if (!parentSignal) return timeoutSignal
    if (!timeoutSignal) return parentSignal
    return AbortSignal.any([parentSignal, timeoutSignal])
}

function abortable(value, signal) {
    const promise = Promise.resolve(value)
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))

    return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
            if (settled) return
            settled = true
            cleanup()
            reject(signal.reason ?? new Error('aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (result) => {
                if (settled) return
                settled = true
                cleanup()
                resolve(result)
            },
            (error) => {
                if (settled) return
                settled = true
                cleanup()
                reject(error)
            },
        )
    })
}

function classifyAbort(error, parentSignal, timeoutSignal) {
    if (parentSignal?.aborted) return ERROR_CODES.CANCELLED
    if (timeoutSignal?.aborted) return ERROR_CODES.TIMEOUT
    if (error?.errorCode === ERROR_CODES.TIMEOUT) return ERROR_CODES.TIMEOUT
    if (error?.name === 'AbortError') return ERROR_CODES.CANCELLED
    return ERROR_CODES.EXECUTION_ERROR
}
