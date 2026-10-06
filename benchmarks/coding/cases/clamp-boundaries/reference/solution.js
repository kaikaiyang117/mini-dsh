import { readFile, writeFile } from 'node:fs/promises'
export async function applyReference({ workspace }) { const p = `${workspace}/calculator.js`; await writeFile(p, (await readFile(p, 'utf8')).replace('Math.min(min, Math.max(max, value))', 'Math.max(min, Math.min(max, value))')) }
