import { createProgressSuite } from '../evals/progress/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({
    suite: createProgressSuite(),
    outputPath: '.eval/progress.json',
})
