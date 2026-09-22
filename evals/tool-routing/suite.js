import { EvalSuite } from '../../src/eval/eval-suite.js'
import { TOOL_ROUTING_CASES } from './cases.js'
import { createToolRoutingFixture } from './fixture.js'

export function createToolRoutingSuite() {
    return new EvalSuite({
        name: 'tool-routing',
        cases: TOOL_ROUTING_CASES,
        variants: ['all', 'deterministic', 'progressive'],
        fixtureFactory: createToolRoutingFixture,
        assertions: [({ report }) => assertRoutingResults(report)],
        reporter: (report) => ({
            headers: [
                'variant',
                'success',
                'avg tools/request',
                'schema tokens/request',
                'estimated input tokens',
                'avg steps',
            ],
            rows: Object.entries(report.variants).map(([variant, summary]) => [
                variant,
                `${summary.successes}/${summary.cases}`,
                format(summary.avgVisibleTools),
                format(summary.avgToolSchemaTokensPerRequest),
                format(summary.avgEstimatedInputTokens),
                format(summary.avgSteps),
            ]),
        }),
    })
}

function assertRoutingResults(report) {
    for (const [variant, summary] of Object.entries(report.variants)) {
        if (summary.successes !== summary.cases)
            throw new Error(`${variant} must pass every Tool Routing case`)
    }
    const large = (variant) =>
        report.results.find(
            (result) => result.caseName === 'large-noisy-catalog' && result.variant === variant,
        )
    if (large('progressive').toolSchemaTokens >= large('all').toolSchemaTokens) {
        throw new Error(
            'progressive must expose fewer schema tokens than all for large-noisy-catalog',
        )
    }
    if (large('progressive').estimatedInputTokens >= large('all').estimatedInputTokens) {
        throw new Error(
            'progressive must estimate fewer input tokens than all for large-noisy-catalog',
        )
    }
}

function format(value) {
    return value === null ? 'n/a' : value.toFixed(2)
}
