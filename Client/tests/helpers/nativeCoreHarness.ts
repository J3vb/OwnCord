import { vi } from "vitest";

export interface NativeCore {
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
}

/** The live holder a `@tauri-apps/api/core` mock reads `invoke` from on every access. */
export function makeCore(): NativeCore {
  return { invoke: undefined };
}

/** Module factory body for `vi.mock("@tauri-apps/api/core", ...)`: `invoke` is a getter on the core. */
export function coreMock(core: NativeCore): { readonly invoke: NativeCore["invoke"] } {
  return {
    get invoke() {
      return core.invoke;
    },
  };
}

/** The suites' `native` control: moves the core between succeeding, failing and unavailable. */
export function nativeControls(core: NativeCore): {
  succeedWith(value: unknown): void;
  failWith(error: unknown): void;
  unavailable(): void;
} {
  return {
    succeedWith(value: unknown) {
      core.invoke = vi.fn().mockResolvedValue(value);
    },
    failWith(error: unknown) {
      core.invoke = vi.fn().mockRejectedValue(error);
    },
    unavailable() {
      core.invoke = undefined;
    },
  };
}
