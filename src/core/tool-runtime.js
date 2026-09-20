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
 *
 * Timeout and parent cancellation are cooperative: the runtime aborts the
 * execution signal and waits for tool.execute() to settle after cleanup.
 * Forced preemption requires process/worker isolation and is outside V2.
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
            runId: exec.runId,
            stepId: exec.stepId,
            toolCallId: exec.toolCallId,
            agent: exec.agent,
        }

        try {
            // Cancellation is cooperative: abort the execution signal, then
            // wait for the tool to finish cleanup and settle before returning.
            const value = await definition.execute(args, execution)
            const cancellation = cancellationCode(signal)
            if (cancellation) {
                return cancellationResult(cancellation, this.#now() - startedAt)
            }
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
            const finalCancellation = cancellationCode(signal)
            if (finalCancellation) {
                return cancellationResult(finalCancellation, this.#now() - startedAt)
            }
            return { ...result, metadata: metadata(this.#now() - startedAt) }
        } catch (error) {
            const errorCode = classifyError(error, signal)
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
    for (const key of ['readOnly', 'idempotent', 'concurrencySafe', 'sideEffect']) {
        if (Object.hasOwn(definition, key) && typeof definition[key] !== 'boolean') {
            throw new TypeError(`tool.${key} must be a boolean`)
        }
    }
    if (
        Object.hasOwn(definition, 'timeoutMs') &&
        definition.timeoutMs !== null &&
        (typeof definition.timeoutMs !== 'number' ||
            !Number.isFinite(definition.timeoutMs) ||
            definition.timeoutMs < 0)
    ) {
        throw new TypeError('tool.timeoutMs must be null or a non-negative finite number')
    }

    const metadata = {
        ...DEFAULT_METADATA,
        timeoutMs: definition.timeoutMs ?? DEFAULT_METADATA.timeoutMs,
        readOnly: definition.readOnly ?? DEFAULT_METADATA.readOnly,
        idempotent: definition.idempotent ?? DEFAULT_METADATA.idempotent,
        concurrencySafe: definition.concurrencySafe ?? DEFAULT_METADATA.concurrencySafe,
        sideEffect: definition.sideEffect ?? DEFAULT_METADATA.sideEffect,
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

function cancellationResult(errorCode, durationMs) {
    const isTimeout = errorCode === ERROR_CODES.TIMEOUT
    return errorResult(
        null,
        [
            {
                type: 'text',
                text: isTimeout
                    ? 'ToolError: tool execution timed out'
                    : 'ToolError: tool cancelled',
            },
        ],
        errorCode,
        metadata(durationMs, {
            timeout: isTimeout,
            cancelled: !isTimeout,
        }),
    )
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

function cancellationCode(signal) {
    if (!signal?.aborted) return null
    return signal.reason?.errorCode === ERROR_CODES.TIMEOUT
        ? ERROR_CODES.TIMEOUT
        : ERROR_CODES.CANCELLED
}

function classifyError(error, signal) {
    const cancellation = cancellationCode(signal)
    if (cancellation) return cancellation
    if (error?.errorCode === ERROR_CODES.TIMEOUT) return ERROR_CODES.TIMEOUT
    if (error?.name === 'AbortError') return ERROR_CODES.CANCELLED
    return ERROR_CODES.EXECUTION_ERROR
}
