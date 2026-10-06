export class Cache { constructor() { this.values = new Map() } get(key) { return this.values.get(key) } set(key, value) { this.values.set(key, value) } delete(key) { this.values.delete(key) } }
