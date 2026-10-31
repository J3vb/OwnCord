type EventHandler = (e: { payload: unknown }) => void;

/** A `@tauri-apps/api/event` module whose `listen` records handlers by event name in `handlers`. */
export function tauriEventMock(handlers: Map<string, Set<EventHandler>>) {
  return {
    listen: (event: string, handler: EventHandler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => set.delete(handler));
    },
  };
}
