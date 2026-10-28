// The core API is loaded per call; a chunk that fails to load (a stale build
// after an update) is a failed command, not an error past the helper.
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const { tryInvoke, invokeOrThrow } = await import("../../../src/platform/desktop/nativeInvoke");

it("hands back a failure when the core API cannot load", async () => {
  const result = await tryInvoke("frontend_ready");
  if (result.ok) throw new Error("expected a failure");
  expect(result.error.command).toBe("frontend_ready");
  expect(result.error.reason).toBeInstanceOf(Error);
  await expect(invokeOrThrow("frontend_ready")).rejects.toMatchObject({
    name: "NativeCallError",
    command: "frontend_ready",
  });
});
