export class DependencyCycleError extends Error { constructor() { super('dependency cycle detected'); this.name = 'DependencyCycleError' } }
