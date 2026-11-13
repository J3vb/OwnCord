import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@lib/api";
import { notifySignIn } from "./lazySignInNotice";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

const showActionToast = vi.hoisted(() => vi.fn());
vi.mock("@lib/ui/toast", () => ({ showActionToast }));
const openSettings = vi.hoisted(() => vi.fn());
vi.mock("@stores/ui.store", () => ({ openSettings }));

const unseen: readonly SessionInfo[] = [
  {
    id: 1,
    device: "",
    ip: "203.0.113.7",
    created_at: "2026-11-13 09:09:00",
    last_used: "2026-11-13 09:09:00",
    is_current: false,
    unseen: true,
  },
];

describe("notifySignIn", () => {
  it("shows the alert once its code has loaded", async () => {
    const showSignInNotice = vi.fn();
    await notifySignIn(unseen, new AbortController().signal, async () => ({ showSignInNotice }));
    expect(showSignInNotice).toHaveBeenCalledWith(unseen);
  });

  it("shows nothing when the session ended while the code was loading", async () => {
    const showSignInNotice = vi.fn();
    const session = new AbortController();
    const module = { showSignInNotice };
    const done = notifySignIn(unseen, session.signal, async () => {
      session.abort();
      return module;
    });
    await done;
    expect(showSignInNotice).not.toHaveBeenCalled();
  });

  it("logs a failed load instead of rejecting, and still tells the user", async () => {
    showActionToast.mockClear();
    const err = new Error("chunk failed");
    await expect(
      notifySignIn(unseen, new AbortController().signal, () => Promise.reject(err)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(String), err);
    expect(showActionToast).toHaveBeenCalledTimes(1);
    const [message, type, action, durationMs] = showActionToast.mock.calls[0]!;
    expect(message).toBe("Unreviewed sign-in to your account");
    expect(type).toBe("info");
    expect(durationMs).toBe(12_000);
    expect((action as { label: string }).label).toBe("Review devices");
    (action as { run: () => void }).run();
    expect(openSettings).toHaveBeenCalledWith("Devices");
  });

  it("shows nothing for a failed load once the session has ended", async () => {
    showActionToast.mockClear();
    const session = new AbortController();
    await notifySignIn(unseen, session.signal, () => {
      session.abort();
      return Promise.reject(new Error("chunk failed"));
    });
    expect(showActionToast).not.toHaveBeenCalled();
  });
});
