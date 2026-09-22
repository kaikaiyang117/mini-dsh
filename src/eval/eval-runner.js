import { performance } from 'node:perf_hooks'
import { TraceRuntime } from '../core/trace-runtime.js'
import { summarizeEvalResults } from './eval-metrics.js'
import { targetToolCalledScorer } from './eval-scorer.js'

export const EVAL_VARIANTS = Object.freeze(['all', 'deterministic', 'progressive'])

export class CapturingTraceRuntime {
    #runtime
    #traces = []

    constructor({ traceRuntime } = {}) {
        this.#runtime =
            traceRuntime ??
            new TraceRuntime({
                directory: '.eval/unused-traces',
                fileSystem: {
                    async mkdir() {},
                    async writeFile() {},
                },
            })
    }

    startRun(options) {
        const handle = this.#runtime.startRun(options)
        return {
            ...handle,
            finish: async (stopReason) => {
                const trace = await handle.finish(stopReason)
                if (!this.#traces.some(({ runId }) => runId === trace.runId)) {
                    this.#traces.push(structuredClone(trace))
                }
                return trace
            },
        }
    }

    latest() {
        return this.#traces.length === 0
            ? null
            : structuredClone(this.#traces[this.#traces.length - 1])
    }
}

export class EvalRunner {
    constructor({
        cases,
        variants = EVAL_VARIANTS,
        fixtureFactory,
        scorer = targetToolCalledScorer,
    } = {}) {
        if (!Array.isArray(cases) || cases.length === 0) {
            throw new TypeError('EvalRunner requires at least one EvalCase')
        }
        if (
            cases.some(
                (item) =>
                    !item?.name || typeof item.prompt !== 'string' || !item.expected?.targetTool,
            )
        ) {
            throw new TypeError('Each EvalCase requires name, prompt, and expected.targetTool')
        }
        if (typeof fixtureFactory !== 'function') {
            throw new TypeError('EvalRunner requires fixtureFactory()')
        }
        if (typeof scorer !== 'function')
            throw new TypeError('EvalRunner scorer must be a function')
        if (
            !Array.isArray(variants) ||
            variants.length === 0 ||
            variants.some((variant) => typeof variant !== 'string' || variant.length === 0) ||
            new Set(variants).size !== variants.length
        ) {
            throw new TypeError('EvalRunner variants must be unique non-empty strings')
        }

        this.cases = cases
        this.variants = [...variants]
        this.fixtureFactory = fixtureFactory
        this.scorer = scorer
    }

    async run() {
        const results = []
        for (const evalCase of this.cases) {
            for (const variant of this.variants) {
                results.push(await this.#runCase(evalCase, variant))
            }
        }
        return {
            variants: summarizeEvalResults(results, this.variants),
            results,
        }
    }

    async #runCase(evalCase, variant) {
        const startedAt = performance.now()
        let fixture
        try {
            fixture = await this.fixtureFactory(evalCase, variant)
        } catch (error) {
            return failedResult(evalCase, variant, performance.now() - startedAt, error)
        }

        if (
            !fixture?.agent ||
            typeof fixture.agent.send !== 'function' ||
            typeof fixture.trace?.latest !== 'function' ||
            !Array.isArray(fixture.recordingTokenMeter?.requests)
        ) {
            throw new TypeError(
                'Eval fixture must expose agent, trace.latest(), and token meter requests',
            )
        }

        let error = null
        try {
            await fixture.agent.send(evalCase.prompt)
        } catch (caught) {
            error = normalizeError(caught)
        } finally {
            try {
                await fixture.dispose?.()
            } catch (caught) {
                error ??= normalizeError(caught)
            }
        }

        const trace = fixture.trace.latest()
        if (!trace)
            throw new Error(`Eval fixture did not capture a Trace for ${evalCase.name}/${variant}`)
        const score = this.scorer(trace, evalCase.expected)
        const requests = fixture.recordingTokenMeter.requests
        const visibleToolCountByStep = requests.map((request) => request.visibleToolCount)
        // Total tool exposure across model requests, not a count of distinct tools.
        const visibleToolCount = visibleToolCountByStep.reduce((total, count) => total + count, 0)
        const toolSchemaTokensByStep = requests.map((request) => request.toolSchemaTokens)
        const estimatedInputTokensByStep = requests.map((request) => request.estimatedInputTokens)

        return {
            caseName: evalCase.name,
            variant,
            success: !error && score.success,
            durationMs: trace.durationMs,
            steps: trace.steps.length,
            toolCalls: trace.steps.reduce((total, step) => total + step.toolCalls.length, 0),
            inputTokens: trace.usage.inputTokens,
            outputTokens: trace.usage.outputTokens,
            reasoningTokens: trace.usage.reasoningTokens,
            cost: trace.usage.cost,
            stopReason: trace.stopReason,
            requestCount: requests.length,
            visibleToolCount,
            visibleToolCountByStep,
            maxVisibleToolCount: requests.reduce(
                (largest, request) => Math.max(largest, request.visibleToolCount),
                0,
            ),
            toolSchemaTokens: toolSchemaTokensByStep.reduce((total, tokens) => total + tokens, 0),
            toolSchemaTokensByStep,
            estimatedInputTokens: estimatedInputTokensByStep.reduce(
                (total, tokens) => total + tokens,
                0,
            ),
            estimatedInputTokensByStep,
            targetToolCalled: score.targetToolCalled,
            targetToolSucceeded: score.targetToolSucceeded,
            error,
        }
    }
}

function failedResult(evalCase, variant, durationMs, error) {
    return {
        caseName: evalCase.name,
        variant,
        success: false,
        durationMs: Math.max(0, durationMs),
        steps: 0,
        toolCalls: 0,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cost: null,
        stopReason: 'internal_error',
        requestCount: 0,
        visibleToolCount: 0,
        visibleToolCountByStep: [],
        maxVisibleToolCount: 0,
        toolSchemaTokens: 0,
        toolSchemaTokensByStep: [],
        estimatedInputTokens: 0,
        estimatedInputTokensByStep: [],
        targetToolCalled: false,
        targetToolSucceeded: false,
        error: normalizeError(error),
    }
}

function normalizeError(error) {
    return {
        name: typeof error?.name === 'string' ? error.name : 'Error',
        message: typeof error?.message === 'string' ? error.message : String(error),
    }
}
