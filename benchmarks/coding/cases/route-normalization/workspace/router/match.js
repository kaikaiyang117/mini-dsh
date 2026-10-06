import { normalizeRoute } from './normalize.js'
export function matchRoute(pattern, pathname) { return normalizeRoute(pattern) === normalizeRoute(pathname) }
