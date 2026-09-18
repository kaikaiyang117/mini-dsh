import { Service } from '@deepseek-ai/cordis'
import { TraceRuntime } from '../core/trace-runtime.js'

/**
 * Exposes TraceRuntime as ctx.trace without coupling the rest of the harness
 * to a particular persistence implementation.
 */
export const name = 'mini-trace'

export function apply(ctx, config = {}) {
    const runtime = new TraceRuntime({
        directory: config.directory ?? process.env.MINI_DSH_TRACE_DIR ?? '.trace',
    })

    class TraceService extends Service {
        constructor(inner) {
            super(inner, 'traceRuntime')
            this.runtime = runtime
        }

        startRun(options) {
            return this.runtime.startRun(options)
        }
    }

    ctx.plugin(TraceService)
}
