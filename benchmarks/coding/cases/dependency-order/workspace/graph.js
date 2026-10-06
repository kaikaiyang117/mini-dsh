export function createGraph(nodes) { return { nodes: nodes.map(({ id, dependencies = [] }) => ({ id, dependencies: [...dependencies] })) } }
