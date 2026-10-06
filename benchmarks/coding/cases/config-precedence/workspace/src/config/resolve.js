import { defaults } from './defaults.js'
import { loadFileConfig } from './file-loader.js'
import { readRuntimeOptions } from './runtime.js'
export function resolveConfig({ file = {}, runtime = {} } = {}) { return { ...defaults, ...readRuntimeOptions(runtime), ...loadFileConfig(file) } }
