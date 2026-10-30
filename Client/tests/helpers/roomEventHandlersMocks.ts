import { vi } from "vitest";

// Pass-through wrapper: the real store still updates; the spy only records the
// speaker lists the handlers publish.
export async function voiceStoreMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("@stores/voice.store")>();
  return { ...actual, setSpeakers: vi.fn(actual.setSpeakers) };
}
