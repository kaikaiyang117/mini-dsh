import { createCrashRecoverySuite } from '../evals/crash-recovery/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({ suite: createCrashRecoverySuite(), outputPath: '.eval/crash-recovery.json' })
