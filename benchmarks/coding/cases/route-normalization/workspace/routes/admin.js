import { compileRoutes } from '../router/compile.js'
export const resolveAdmin = compileRoutes([{ path: '/admin', name: 'dashboard' }, { path: '/admin/users', name: 'users' }])
