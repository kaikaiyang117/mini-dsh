import assert from 'node:assert/strict'; import test from 'node:test'; import { formatRequestLog } from './src/request-log.js'
test('request logging hides nested secrets', () => { const log = JSON.parse(formatRequestLog({ user: { token: 'x' }, list: [{ password: 'y' }] })); assert.equal(log.request.user.token, '[REDACTED]'); assert.equal(log.request.list[0].password, '[REDACTED]') })
