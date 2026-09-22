import { Service } from '@deepseek-ai/cordis'
import { McpManager } from '../core/mcp-manager.js'

export const name = 'mini-mcp'
export const inject = ['tools']

export async function apply(ctx, config = {}) {
    const manager = new McpManager({
        activate: (definition) => activatePlugin(ctx, definition),
    })
    const McpService = class extends Service {
        constructor(serviceContext) {
            super(serviceContext, 'mcp')
        }

        register(definition) {
            return manager.register(definition)
        }

        list() {
            return manager.list()
        }

        get(serverName) {
            return manager.get(serverName)
        }

        connect(serverName) {
            return manager.connect(serverName)
        }

        disconnect(serverName) {
            return manager.disconnect(serverName)
        }

        reload(serverName) {
            return manager.reload(serverName)
        }

        async dispose() {
            return manager.dispose()
        }
    }

    await ctx.plugin(McpService)
    ctx.effect(() => () => manager.dispose(), 'mcp manager')

    for (const definition of config.servers ?? []) manager.register(definition)
    const autoStarted = await manager.startAuto()
    for (const status of autoStarted) {
        if (status.state === 'FAILED') {
            console.error(
                `[mcp] failed: ${status.name}: ${status.lastError?.message ?? 'unknown error'}`,
            )
        }
    }
}

async function activatePlugin(ctx, definition) {
    let fiber = null
    try {
        const mod = await import(definition.package)
        fiber = ctx.plugin(mod, definition.config)
        await fiber
        return {
            dispose: () => fiber.dispose(),
        }
    } catch (error) {
        if (fiber) await fiber.dispose().catch(() => {})
        throw error
    }
}
