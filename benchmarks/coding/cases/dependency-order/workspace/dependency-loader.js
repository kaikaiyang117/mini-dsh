export function dependenciesFor(graph, id) { return graph.nodes.find((node) => node.id === id)?.dependencies ?? [] }
