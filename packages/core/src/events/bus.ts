import type { DomainEvent, DomainEventType, EventSink } from './types.js';

/**
 * A tiny synchronous event bus. It exists outside the reducer on purpose: the
 * reducer stays a pure `(state, action, ctx) => state` function and merely
 * writes to the sink `ctx` hands it, so replaying an action log with a
 * throwaway bus reproduces exactly the same events.
 */
export interface EventBus {
  readonly emit: EventSink;
  subscribe(listener: EventSink): () => void;
  /** Listen to one event type only — the common case for flourishes/sound. */
  on<T extends DomainEventType>(
    type: T,
    listener: (event: Extract<DomainEvent, { type: T }>) => void,
  ): () => void;
  /** Everything emitted since the last drain, in emission order. */
  drain(): readonly DomainEvent[];
}

export interface EventBusOptions {
  /**
   * Keep emitted events for `drain()`. On by default; long-lived buses (the app
   * store) turn it off so the buffer cannot grow without bound.
   */
  readonly buffer?: boolean;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const buffered = options.buffer ?? true;
  const listeners = new Set<EventSink>();
  let buffer: DomainEvent[] = [];

  const bus: EventBus = {
    emit(event) {
      if (buffered) {
        buffer.push(event);
      }
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    on(type, listener) {
      return bus.subscribe((event) => {
        if (event.type === type) {
          listener(event as Extract<DomainEvent, { type: typeof type }>);
        }
      });
    },
    drain() {
      const drained = buffer;
      buffer = [];
      return drained;
    },
  };
  return bus;
}

/** Runs `body` with a fresh bus and returns both its result and the events. */
export function collectEvents<T>(body: (emit: EventSink) => T): {
  readonly result: T;
  readonly events: readonly DomainEvent[];
} {
  const bus = createEventBus();
  const result = body(bus.emit);
  return { result, events: bus.drain() };
}

export function countEventsByType(
  events: readonly DomainEvent[],
): Readonly<Partial<Record<DomainEventType, number>>> {
  const counts: Partial<Record<DomainEventType, number>> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}
