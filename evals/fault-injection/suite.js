import { EvalSuite } from '../../src/eval/eval-suite.js'
import { FAULT_INJECTION_CASES } from './cases.js'
import { createFaultInjectionFixture, scoreFaultInjection } from './fixture.js'

const VARIANTS = ['default']

export function createFaultInjectionSuite() {
    return new EvalSuite({
        name: 'fault-injection-core-runtime',
        cases: FAULT_INJECTION_CASES,
        variants: VARIANTS,
        fixtureFactory: createFaultInjectionFixture,
        scorer: scoreFaultInjection,
        assertions: [({ report }) => assertFaultInjectionResults(report)],
        reporter: (report) => ({
            headers: [
                'case',
                'success',
                'expected stop',
                'actual stop',
                'tool calls',
                'results',
                'failures',
                'cancelled',
                'protocol',
            ],
            rows: report.results.map((result) => [
                result.caseName,
                result.success,
                result.scoreDetails.expectedStopReason,
                result.stopReason,
                result.scoreDetails.toolCallCount,
                result.scoreDetails.toolResultCount,
                result.scoreDetails.toolFailures,
                result.scoreDetails.cancelledToolResults,
                result.scoreDetails.protocolComplete,
            ]),
        }),
    })
}

export function assertFaultInjectionResults(report) {
    for (const result of report.results) {
        if (!result.success)
            throw new Error(`${result.caseName} did not meet its fault expectation`)
        if (result.stopReason !== result.scoreDetails.expectedStopReason) {
            throw new Error(`${result.caseName} stopped with an unexpected reason`)
        }
        if (!result.scoreDetails.protocolComplete) {
            throw new Error(`${result.caseName} left an incomplete Tool protocol`)
        }
        if (!result.scoreDetails.caseInvariant) {
            throw new Error(`${result.caseName} violated its case-specific invariant`)
        }
    }
}
