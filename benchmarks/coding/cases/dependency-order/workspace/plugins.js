import { dependencyOrder } from './order.js'
export function orderPlugins(graph) { return dependencyOrder(graph) }
