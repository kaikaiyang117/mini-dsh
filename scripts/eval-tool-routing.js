import { createToolRoutingSuite } from '../evals/tool-routing/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({
    suite: createToolRoutingSuite(),
    outputPath: '.eval/tool-routing.json',
})
