import { EvalSuite } from '../../src/eval/eval-suite.js'
import { CRASH_RECOVERY_CASES } from './cases.js'
import { createCrashRecoveryFixture, scoreCrashRecovery } from './fixture.js'

const VARIANTS = ['default']

export function createCrashRecoverySuite() {
    return new EvalSuite({
        name: 'crash-resume-recovery',
        cases: CRASH_RECOVERY_CASES,
        variants: VARIANTS,
        fixtureFactory: createCrashRecoveryFixture,
        scorer: scoreCrashRecovery,
        assertions: [
            ({ report }) => {
                for (const result of report.results) {
                    if (!result.success)
                        throw new Error(`${result.caseName} must recover successfully`)
                }
            },
        ],
        reporter: (report) => ({
            headers: [
                'case',
                'recovered',
                'unknown',
                'side effects',
                'resume',
                'protocol',
                'sequence',
            ],
            rows: report.results.map((result) => [
                result.caseName,
                result.scoreDetails.recovered,
                result.scoreDetails.recoveredUnknownCount,
                result.scoreDetails.externalEffectCount,
                result.scoreDetails.resumed,
                result.scoreDetails.protocolComplete,
                result.scoreDetails.sequenceContinuous,
            ]),
        }),
    })
}
