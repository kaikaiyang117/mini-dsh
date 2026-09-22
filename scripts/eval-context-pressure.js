import { createContextPressureSuite } from '../evals/context-pressure/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({
    suite: createContextPressureSuite(),
    outputPath: '.eval/context-pressure.json',
})
