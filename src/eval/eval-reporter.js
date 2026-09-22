import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonReport(report, path) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function renderMarkdownTable({ headers, rows }) {
    if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows)) {
        throw new TypeError('Markdown table requires non-empty headers and a rows array')
    }
    if (rows.some((row) => !Array.isArray(row) || row.length !== headers.length)) {
        throw new TypeError('Markdown table rows must match the header column count')
    }
    const cells = [headers, ...rows].map((row) => row.map((value) => escapeCell(value)))
    const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column].length)))
    const format = (row) =>
        `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`
    const divider = `| ${widths.map((width) => '-'.repeat(Math.max(3, width))).join(' | ')} |`
    return [format(cells[0]), divider, ...cells.slice(1).map(format)].join('\n')
}

function escapeCell(value) {
    return String(value ?? '')
        .replaceAll('|', '\\|')
        .replaceAll('\n', ' ')
}
