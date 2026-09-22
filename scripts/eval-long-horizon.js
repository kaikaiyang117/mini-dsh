import { createLongHorizonSuite } from '../evals/long-horizon/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({
    suite: createLongHorizonSuite(),
    outputPath: '.eval/long-horizon.json',
})
