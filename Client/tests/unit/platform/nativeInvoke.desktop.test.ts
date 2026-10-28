// The shared door to host commands: a rejection, whatever the host rejected
// with, comes back as a result or a `NativeCallError` that keeps the raw
// reason; a missing bridge fails the same way instead of throwing past it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const core: { invoke: ((cmd: string, args?: unknown) => Promise<unknown>) | undefined } = {
  invoke: undefined,
};
vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return core.invoke;
  },
}));

const { tryInvoke, invokeOrThrow, NativeCallError } =
  await import("../../../src/platform/desktop/nativeInvoke");

describe("tryInvoke", () => {
  beforeEach(() => {
    core.invoke = undefined;
  });

  it("hands back the command's value, passing no args when none are given", async () => {
    const invoke = vi.fn().mockResolvedValue(42);
    core.invoke = invoke;
    await expect(tryInvoke<number>("system_idle_ms")).resolves.toEqual({ ok: true, value: 42 });
    await tryInvoke("set_unread_badge", { count: 3 });
    expect(invoke.mock.calls).toEqual([["system_idle_ms"], ["set_unread_badge", { count: 3 }]]);
  });

  it("keeps a string rejection as the reason and as the message", async () => {
    core.invoke = vi.fn().mockRejectedValue("unsupported_ptt_key: 255");
    const result = await tryInvoke("ptt_set_key", { vkCode: 255 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(NativeCallError);
    expect(result.error.command).toBe("ptt_set_key");
    expect(result.error.reason).toBe("unsupported_ptt_key: 255");
    expect(result.error.message).toBe("unsupported_ptt_key: 255");
  });

  it("keeps a {stage, message} rejection whole and reads its message", async () => {
    const refusal = { stage: "refused", message: "encoder busy" };
    core.invoke = vi.fn().mockRejectedValue(refusal);
    const result = await tryInvoke("native_voice_set_screen_quality");
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.reason).toBe(refusal);
    expect(result.error.message).toBe("encoder busy");
  });

  it("reads an Error rejection's message and keeps the Error", async () => {
    const err = new Error("disk full");
    core.invoke = vi.fn().mockRejectedValue(err);
    const result = await tryInvoke("save_pending_messages");
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.reason).toBe(err);
    expect(result.error.message).toBe("disk full");
  });

  it("fails as a result when there is no native bridge at all", async () => {
    core.invoke = undefined;
    const result = await tryInvoke("frontend_ready");
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.command).toBe("frontend_ready");
    expect(result.error.reason).toBeInstanceOf(TypeError);
  });

  it("fails as a result when the bridge throws before it returns a promise", async () => {
    core.invoke = () => {
      throw new Error("__TAURI_INTERNALS__ is undefined");
    };
    await expect(tryInvoke("open_devtools")).resolves.toMatchObject({ ok: false });
  });
});

describe("invokeOrThrow", () => {
  it("resolves with the value", async () => {
    core.invoke = vi.fn().mockResolvedValue("sid-1");
    await expect(invokeOrThrow<string>("native_voice_publish_camera")).resolves.toBe("sid-1");
  });

  it("rejects with a NativeCallError carrying the host's reason", async () => {
    core.invoke = vi.fn().mockRejectedValue("camera busy");
    const refused = invokeOrThrow("native_voice_start_camera");
    await expect(refused).rejects.toBeInstanceOf(NativeCallError);
    await expect(refused).rejects.toThrow("camera busy");
    await expect(refused).rejects.toMatchObject({ reason: "camera busy" });
  });
});

describe("notifier.setUnreadBadge, the worked example", () => {
  it("resolves when the host has no badge command", async () => {
    core.invoke = vi.fn().mockRejectedValue("command set_unread_badge not found");
    const { notifier } = await import("../../../src/platform/desktop/notifications");
    await expect(notifier.setUnreadBadge(4)).resolves.toBeUndefined();
  });
});
