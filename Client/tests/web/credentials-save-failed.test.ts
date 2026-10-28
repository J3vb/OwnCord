/**
 * The portal's profile-edit credential refresh: when the re-save answers false
 * or rejects, the caller's `onSaveFailed` runs once; a successful save never
 * calls it. Runs in the web project because the callback is portal-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authStore, clearAuth } from "@stores/auth.store";
import { createUserUpdateCredentialSaver } from "@lib/credentials";
import { desktop } from "../../src/platform/desktop";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  authStore.setState(() => ({
    token: "sess-token",
    user: { id: 1, username: "alice", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAuth();
});

describe("createUserUpdateCredentialSaver on the web portal", () => {
  it("does not call onSaveFailed when the save succeeds", async () => {
    const save = vi.spyOn(desktop.credentials, "save").mockResolvedValue(true);
    const onSaveFailed = vi.fn();

    createUserUpdateCredentialSaver(
      "h.example",
      true,
      onSaveFailed,
    )({ user_id: 1, username: "a2" });
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });

  it("calls onSaveFailed once when the save answers false", async () => {
    vi.spyOn(desktop.credentials, "save").mockResolvedValue(false);
    const onSaveFailed = vi.fn();

    createUserUpdateCredentialSaver(
      "h.example",
      true,
      onSaveFailed,
    )({ user_id: 1, username: "a2" });
    await flush();

    expect(onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it("calls onSaveFailed once when the save rejects", async () => {
    vi.spyOn(desktop.credentials, "save").mockRejectedValue(new Error("storage unavailable"));
    const onSaveFailed = vi.fn();

    createUserUpdateCredentialSaver(
      "h.example",
      true,
      onSaveFailed,
    )({ user_id: 1, username: "a2" });
    await flush();

    expect(onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it("saves without a callback when none is supplied", async () => {
    const save = vi.spyOn(desktop.credentials, "save").mockResolvedValue(false);

    createUserUpdateCredentialSaver("h.example", true)({ user_id: 1, username: "a2" });
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
  });
});
