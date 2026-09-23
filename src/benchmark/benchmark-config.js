export const CODING_VARIANTS = Object.freeze(['minimal', 'full'])
export const DEFAULT_BENCHMARK_MODEL = 'deepseek/deepseek-v4-pro'
export const DEFAULT_BENCHMARK_OUTPUT = '.benchmark/coding.json'

export function parseBenchmarkArgs(args, env = process.env) {
    const selectedCases = []
    const variants = []
    const config = {
        model: env.MINI_DSH_MODEL || DEFAULT_BENCHMARK_MODEL,
        repetitions: 1,
        output: DEFAULT_BENCHMARK_OUTPUT,
        maxTotalCost: null,
        allowUnknownCost: false,
        dryRun: false,
    }

    for (let index = 0; index < args.length; index += 1) {
        const option = args[index]
        if (option === '--dry-run' || option === '--allow-unknown-cost') {
            config[option === '--dry-run' ? 'dryRun' : 'allowUnknownCost'] = true
            continue
        }
        if (
            ![
                '--model',
                '--variant',
                '--variants',
                '--case',
                '--cases',
                '--repeat',
                '--output',
                '--max-total-cost',
            ].includes(option)
        ) {
            throw new TypeError(`unknown benchmark option: ${option}`)
        }
        const value = args[++index]
        if (!value || value.startsWith('--')) throw new TypeError(`${option} requires a value`)
        if (option === '--model') config.model = value
        if (option === '--output') config.output = value
        if (option === '--repeat') {
            if (!/^[1-9]\d*$/.test(value))
                throw new TypeError('--repeat must be a positive integer')
            config.repetitions = Number(value)
        }
        if (option === '--max-total-cost') {
            config.maxTotalCost = Number(value)
            if (!Number.isFinite(config.maxTotalCost) || config.maxTotalCost < 0) {
                throw new TypeError('--max-total-cost must be a non-negative number')
            }
        }
        if (option === '--variant' || option === '--variants') variants.push(...splitNames(value))
        if (option === '--case' || option === '--cases') selectedCases.push(...splitNames(value))
    }

    if (!/^[^/\s]+\/[^/\s]+$/.test(config.model)) {
        throw new TypeError('--model must be provider/model')
    }
    if (!Number.isSafeInteger(config.repetitions)) {
        throw new TypeError('--repeat is too large')
    }
    return {
        ...config,
        variants: [...new Set(variants.length ? variants : CODING_VARIANTS)],
        selectedCases: [...new Set(selectedCases)],
    }
}

export function selectBenchmarkMatrix(suite, config) {
    const unknownVariants = config.variants.filter((variant) => !suite.variants.includes(variant))
    const unknownCases = config.selectedCases.filter(
        (name) => !suite.cases.some((evalCase) => evalCase.name === name),
    )
    if (unknownVariants.length)
        throw new TypeError(`unknown variant: ${unknownVariants.join(', ')}`)
    if (unknownCases.length) throw new TypeError(`unknown case: ${unknownCases.join(', ')}`)
    const cases = config.selectedCases.length
        ? suite.cases.filter((evalCase) => config.selectedCases.includes(evalCase.name))
        : suite.cases
    const variants = suite.variants.filter((variant) => config.variants.includes(variant))
    return { cases, variants, plannedRuns: cases.length * variants.length * config.repetitions }
}

function splitNames(value) {
    const names = value.split(',').map((part) => part.trim())
    if (names.some((part) => !part)) throw new TypeError('case and variant names must not be empty')
    return names
}
