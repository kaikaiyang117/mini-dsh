import { validateEmail } from './validation/email.js'
export function update(current, input) { const next = { ...current, ...input }; if (!next.name) throw new Error('name required'); validateEmail(next.email); return next }
