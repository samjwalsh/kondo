import { EventEmitter } from "node:events";
import type { KondoEvent } from "../../shared/api.js";

/** In-process event bus; the UI receives the same events over /api/events. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: KondoEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: KondoEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
