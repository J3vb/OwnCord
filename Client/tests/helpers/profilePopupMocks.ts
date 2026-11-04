import { vi } from "vitest";

/**
 * Factory body for `vi.mock("../../src/features/profiles/userNotes", ...)`: the real
 * module, with every note binding spied on and recorded in `bindings` so a test can
 * see which card flushed its note.
 */
export async function noteBindingSpyMock(
  importOriginal: <T>() => Promise<T>,
  bindings: { destroy: () => void }[],
) {
  const actual = await importOriginal<typeof import("../../src/features/profiles/userNotes")>();
  return {
    ...actual,
    createNoteBinding: (...args: Parameters<typeof actual.createNoteBinding>) => {
      const binding = actual.createNoteBinding(...args);
      vi.spyOn(binding, "destroy");
      bindings.push(binding);
      return binding;
    },
  };
}
