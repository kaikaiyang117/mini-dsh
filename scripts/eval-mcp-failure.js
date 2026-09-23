import { createMcpFailureSuite } from '../evals/mcp-failure/suite.js'
import { runEvalCli } from '../src/eval/eval-cli.js'

await runEvalCli({ suite: createMcpFailureSuite(), outputPath: '.eval/mcp-failure.json' })
