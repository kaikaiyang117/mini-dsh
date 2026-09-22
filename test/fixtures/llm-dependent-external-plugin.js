export const name = 'llm-dependent-external-plugin'
export const inject = ['llm']

export let activatedWithLlm = false

export function apply(ctx) {
    activatedWithLlm = Boolean(ctx.llm)
}
