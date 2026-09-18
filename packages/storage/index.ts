import type {StorageEngine,Task} from '../core/index.js';
import {freeze} from '../core/index.js';
export class InMemoryStorage implements StorageEngine {private readonly items=new Map<string,Task>();get(id:string){return this.items.get(id)}put(task:Task){this.items.set(task.id,freeze(task))}delete(id:string){this.items.delete(id)}list(){return Object.freeze([...this.items.values()])}}
