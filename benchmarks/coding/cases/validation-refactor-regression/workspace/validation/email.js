import { isEmail } from './email-format.js'
export function validateEmail(value) { if (value !== undefined && !isEmail(value)) throw new Error('email invalid') }
