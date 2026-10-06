import { compileRoutes } from '../router/compile.js'
export const resolveAsset = compileRoutes([{ path: '/assets/app.js', name: 'app' }, { path: '/assets/site.css', name: 'style' }])
