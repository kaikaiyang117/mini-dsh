export function resolveConfig(defaults, file, runtime) { return { ...defaults, ...runtime, ...file } }
