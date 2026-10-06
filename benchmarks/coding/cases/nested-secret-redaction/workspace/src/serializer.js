import { redact } from './redact.js'
export function serialize(value) { return JSON.stringify(redact(value)) }
