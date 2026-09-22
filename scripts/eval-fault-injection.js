import { createFaultInjectionSuite } from '../evals/fault-injection/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({
    suite: createFaultInjectionSuite(),
    outputPath: '.eval/fault-injection.json',
})
