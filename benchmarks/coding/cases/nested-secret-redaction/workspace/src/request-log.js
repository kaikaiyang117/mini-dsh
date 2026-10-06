import { logRecord } from './logger.js'
export function formatRequestLog(request) { return logRecord({ kind: 'request', request }) }
