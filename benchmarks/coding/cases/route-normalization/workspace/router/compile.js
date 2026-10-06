import { matchRoute } from './match.js'
export function compileRoutes(routes) { return (pathname) => routes.find(({ path }) => matchRoute(path, pathname))?.name }
