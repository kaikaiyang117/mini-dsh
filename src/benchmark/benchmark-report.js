import { execFileSync } from 'node:child_process'
import { renderMarkdownTable } from '../eval/eval-reporter.js'

export function gitCommit(cwd = process.cwd()) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
    } catch {
        return null
    }
}

export function summarizeBenchmark(results, variants, plannedRuns, budgetStopped) {
    const byVariant = Object.fromEntries(
        variants.map((variant) => [
            variant,
            summarizeSamples(results.filter((row) => row.variant === variant)),
        ]),
    )
    const overall = summarizeSamples(results)
    return {
        plannedRuns,
        startedRuns: results.length,
        completedRuns: results.length,
        skippedRuns: plannedRuns - results.length,
        budgetStopped,
        totalKnownCost: overall.totalKnownCost,
        costAvailability: overall.costAvailability,
        variants: byVariant,
    }
}

function summarizeSamples(rows) {
    const count = rows.length
    const knownCosts = rows.map((row) => row.cost).filter(isKnown)
    const sum = (key) => rows.reduce((total, row) => total + row[key], 0)
    const average = (key) => (count ? sum(key) / count : null)
    const averageKnown = (key) => {
        const values = rows.map((row) => row[key]).filter(isKnown)
        return values.length
            ? values.reduce((total, value) => total + value, 0) / values.length
            : null
    }
    const requestCount = sum('requestCount')
    return {
        samples: count,
        successes: rows.filter((row) => row.success).length,
        successRate: count ? rows.filter((row) => row.success).length / count : null,
        avgSteps: average('steps'),
        avgToolCalls: average('toolCalls'),
        avgToolErrors: average('toolErrors'),
        avgRequestCount: average('requestCount'),
        avgInputTokens: averageKnown('inputTokens'),
        avgOutputTokens: averageKnown('outputTokens'),
        avgReasoningTokens: averageKnown('reasoningTokens'),
        avgEstimatedInputTokens: average('estimatedInputTokens'),
        avgToolSchemaTokens: average('toolSchemaTokens'),
        avgVisibleToolsPerRequest: requestCount ? sum('visibleToolCount') / requestCount : null,
        avgDurationMs: average('durationMs'),
        totalKnownCost: knownCosts.reduce((total, value) => total + value, 0),
        costAvailability: !knownCosts.length
            ? 'unavailable'
            : knownCosts.length === count
              ? 'available'
              : 'partial',
    }
}

function isKnown(value) {
    return typeof value === 'number' && Number.isFinite(value)
}

export function renderBenchmarkTable(report) {
    return renderMarkdownTable({
        headers: [
            'variant',
            'success',
            'samples',
            'avg steps',
            'avg tool calls',
            'input tokens',
            'estimated input',
            'cost',
            'duration ms',
        ],
        rows: Object.entries(report.summary.variants).map(([variant, row]) => [
            variant,
            `${row.successes}/${row.samples}`,
            row.samples,
            format(row.avgSteps),
            format(row.avgToolCalls),
            format(row.avgInputTokens),
            format(row.avgEstimatedInputTokens),
            row.costAvailability === 'unavailable' ? 'unknown' : format(row.totalKnownCost),
            format(row.avgDurationMs),
        ]),
    })
}

function format(value) {
    return value === null ? 'n/a' : Number(value.toFixed(2))
}
