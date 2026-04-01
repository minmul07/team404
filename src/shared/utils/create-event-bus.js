import { EventEmitter } from 'node:events';

export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return emitter;
}
