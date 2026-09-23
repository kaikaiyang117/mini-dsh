import { runCodingBenchmarkCli } from '../src/benchmark/benchmark-cli.js'

try {
    await runCodingBenchmarkCli()
} catch (error) {
    console.error(error?.message ?? error)
    process.exitCode = 1
}
