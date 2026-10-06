import { readFile, writeFile } from 'node:fs/promises'
export async function applyReference({ workspace }) { const p = `${workspace}/retry.js`; await writeFile(p, `export async function runWithRetry(operation, maxRetries) { let attempt = 0; while (attempt <= maxRetries) { try { return await operation() } catch (error) { attempt++; if (attempt > maxRetries) throw error } } }\n`) }
