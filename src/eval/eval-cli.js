import { renderMarkdownTable, writeJsonReport } from './eval-reporter.js'
import { runEvalSuite } from './eval-suite.js'

export async function runEvalCli({ suite, outputPath, table }) {
    try {
        const report = await runEvalSuite(suite)
        await writeJsonReport(report, outputPath)
        const tableSpec = table ?? suite.reporter
        if (tableSpec) {
            const data = typeof tableSpec === 'function' ? tableSpec(report) : tableSpec
            console.log(renderMarkdownTable(data))
        }
        console.log(`\nMachine-readable report: ${outputPath}`)
        return report
    } catch (error) {
        console.error(error?.stack ?? error)
        process.exitCode = 1
        return null
    }
}
