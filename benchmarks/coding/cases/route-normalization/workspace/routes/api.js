import { compileRoutes } from '../router/compile.js'
export const resolveApi = compileRoutes([{ path: '/api/users', name: 'users' }, { path: '/api/items', name: 'items' }])
