import { vi } from "vitest";

// jsdom has no ResizeObserver. Importing this module installs an inert one
// when the environment lacks it; a suite that needs to drive resizes installs
// its own capturing fake instead.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/** Replaces ResizeObserver for the current test; every observer's callback is pushed onto `observers`. */
export function stubCapturingResizeObserver(observers: Array<() => void>): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}
