import { validateEmail } from './validation/email.js'
export function create(input) { if (!input.name) throw new Error('name required'); validateEmail(input.email); return { ...input } }
