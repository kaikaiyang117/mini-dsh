import { readFile } from 'node:fs/promises'
export async function verify({ workspace }) { const text = await readFile(`${workspace}/calculator.js`, 'utf8'); return { passed: text.includes('Math.max(min, Math.min(max, value))'), reason: 'clamp order' } }
