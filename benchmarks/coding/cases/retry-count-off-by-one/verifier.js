import { readFile } from 'node:fs/promises'
export async function verify({ workspace }) { const text = await readFile(`${workspace}/retry.js`, 'utf8'); return { passed: text.includes('attempt <= maxRetries'), reason: 'retry loop includes final attempt' } }
