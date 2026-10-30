// jsdom has no ResizeObserver; the member menu re-clamps itself through one.
// The fake hands the latest observer's callback to tests that resize the menu.
export let lastResizeCallback: (() => void) | null = null;

globalThis.ResizeObserver = class {
  constructor(callback: () => void) {
    lastResizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;
