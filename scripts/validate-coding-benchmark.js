import { validateCodingBenchmark } from '../benchmarks/coding/validator.js'

try {
    const report = await validateCodingBenchmark()
    console.log(`Coding Benchmark V1: ${report.cases.length}/16 cases valid`)
} catch (error) {
    console.error(`Coding Benchmark V1 validation failed: ${error.message}`)
    process.exitCode = 1
}
