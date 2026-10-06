import { Store } from './store.js'
export class Repository { constructor() { this.store = new Store() } add(item) { this.store.add(item) } rename(id, name) { this.store.rename(id, name) } findByName(name) { return this.store.findByName(name) } }
