import { completionScorer } from './eval-scorer.js'

export const EVAL_LIMIT_KEYS = Object.freeze([
    'maxSteps',
    'maxToolCalls',
    'maxInputTokens',
    'maxOutputTokens',
    'maxDurationMs',
    'maxCost',
    'maxToolFailures',
])

const INTEGER_EVAL_LIMIT_KEYS = new Set([
    'maxSteps',
    'maxToolCalls',
    'maxInputTokens',
    'maxOutputTokens',
    'maxToolFailures',
])

export class EvalSuite {
    constructor({
        name,
        cases,
        variants,
        fixtureFactory,
        scorer = completionScorer,
        assertions = [],
        assertReport,
        reporter,
    } = {}) {
        if (typeof name !== 'string' || !name.trim())
            throw new TypeError('EvalSuite requires a name')
        if (!Array.isArray(cases) || cases.length === 0)
            throw new TypeError('EvalSuite requires at least one EvalCase')
        if (cases.some((evalCase) => !isValidEvalCase(evalCase)))
            throw new TypeError('EvalSuite contains an invalid EvalCase')
        if (new Set(cases.map(({ name: caseName }) => caseName)).size !== cases.length) {
            throw new TypeError('EvalCase names must be unique within a suite')
        }
        if (
            !Array.isArray(variants) ||
            variants.length === 0 ||
            variants.some((value) => typeof value !== 'string' || !value.trim()) ||
            new Set(variants).size !== variants.length
        ) {
            throw new TypeError('EvalSuite variants must be unique non-empty strings')
        }
        if (typeof fixtureFactory !== 'function')
            throw new TypeError('EvalSuite requires fixtureFactory()')
        if (typeof scorer !== 'function') throw new TypeError('EvalSuite scorer must be a function')
        if (
            !Array.isArray(assertions) ||
            assertions.some((assertion) => typeof assertion !== 'function')
        ) {
            throw new TypeError('EvalSuite assertions must be an array of functions')
        }
        if (reporter !== undefined && typeof reporter !== 'function')
            throw new TypeError('EvalSuite reporter must be a function')
        if (assertReport !== undefined && typeof assertReport !== 'function')
            throw new TypeError('EvalSuite assertReport must be a function')

        this.name = name
        this.cases = [...cases]
        this.variants = [...variants]
        this.fixtureFactory = fixtureFactory
        this.scorer = scorer
        this.assertions = [...assertions]
        this.assertReport = assertReport
        this.reporter = reporter
    }
}

export async function runEvalSuite(suite) {
    if (!(suite instanceof EvalSuite)) throw new TypeError('runEvalSuite requires an EvalSuite')
    const { EvalRunner } = await import('./eval-runner.js')
    const report = await new EvalRunner({
        suiteName: suite.name,
        cases: suite.cases,
        variants: suite.variants,
        fixtureFactory: suite.fixtureFactory,
        scorer: suite.scorer,
    }).run()
    for (const assertion of suite.assertions) await assertion({ report, suite })
    await suite.assertReport?.(report)
    return report
}

export function isValidEvalCase(item) {
    if (
        !item ||
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        typeof item.prompt !== 'string' ||
        !item.expected
    )
        return false
    if (item.scorer !== undefined && typeof item.scorer !== 'function') return false
    if (
        item.limits !== undefined &&
        (!item.limits || typeof item.limits !== 'object' || Array.isArray(item.limits))
    )
        return false
    if (
        item.limits &&
        Object.entries(item.limits).some(
            ([key, value]) =>
                !EVAL_LIMIT_KEYS.includes(key) ||
                typeof value !== 'number' ||
                !Number.isFinite(value) ||
                value < 0 ||
                (INTEGER_EVAL_LIMIT_KEYS.has(key) && !Number.isInteger(value)),
        )
    )
        return false
    if (item.expected.completion === undefined || item.expected.completion === 'target-tool') {
        return typeof item.expected.targetTool === 'string' && item.expected.targetTool.length > 0
    }
    if (item.expected.completion !== 'stop-reason') return false
    const stopReasons =
        typeof item.expected.stopReason === 'string'
            ? [item.expected.stopReason]
            : Object.values(item.expected.stopReason ?? {})
    return (
        stopReasons.length > 0 &&
        stopReasons.every((reason) => typeof reason === 'string' && reason.length > 0)
    )
}
