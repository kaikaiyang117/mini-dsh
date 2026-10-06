export class Service { constructor(repository) { this.repository = repository } read(key) { return this.repository.get(key) } update(key, value) { this.repository.set(key, value) } }
