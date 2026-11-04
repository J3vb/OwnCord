import { vi } from "vitest";

/** Makes `matchMedia` report a coarse pointer (a phone) when `on`, and nothing else. */
export function usePhone(on = true): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: on && q.includes("pointer: coarse") })),
  );
}
