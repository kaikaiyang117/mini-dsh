import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonReport(report, path) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function renderMarkdownTable({ headers, rows }) {
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
