import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }));
const credentials = vi.hoisted(() => ({
  loadCredential: vi.fn(),
  saveCredential: vi.fn(),
}));

vi.mock("@lib/net/credentials", () => credentials);
vi.mock("../../src/features/settings/SettingsOverlay", () => ({
  createSettingsOverlay: (deps: Record<string, unknown>) => {
    captured.deps = deps;
    return {};
  },
}));
vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn(), showChangeOutcomeToast: vi.fn() }));
vi.mock("../../src/features/connection/logout", () => ({ logout: vi.fn() }));
vi.mock("../../src/features/navigation/destinations", () => ({ NAVIGATION_DESTINATIONS: {} }));
vi.mock("../../src/features/messaging/content/attachments", () => ({
  fetchImageAsObjectUrl: vi.fn(),
  formatFileSize: vi.fn(),
  isImageMime: vi.fn(),
  pruneAttachmentCacheScope: vi.fn(),
  resolveServerUrl: vi.fn(),
  thumbnailUrl: vi.fn(),
}));

import { expectConsole } from "../helpers/console";
import { authStore } from "@stores/auth.store";
import type { ApiClient } from "@lib/api";
import { createAccountSettingsOverlay } from "../../src/features/settings/mountSettings";

type ChangePassword = (oldPw: string, newPw: string, revoke: boolean) => Promise<unknown>;

function mountWith(changePassword: ReturnType<typeof vi.fn>): ChangePassword {
  const api = {
    changePassword,
    getConfig: () => ({ host: "chat.example" }),
  } as unknown as ApiClient;
  createAccountSettingsOverlay({
    api,
    cacheScope: null,
    fallbackFocus: () => null,
    applyPresence: () => undefined,
  });
  return captured.deps?.onChangePassword as ChangePassword;
}

describe("changing the password in Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authStore.setState((s) => ({ ...s, token: "tok-1" }));
    credentials.saveCredential.mockResolvedValue(true);
  });

  it("replaces the remembered password with the new one", async () => {
    credentials.loadCredential.mockResolvedValue({ username: "ann", hasPassword: true });
    const change = mountWith(vi.fn().mockResolvedValue({ revoked: true }));
    await change("old", "new-secret", false);
    expect(credentials.saveCredential).toHaveBeenCalledWith(
      "chat.example",
      "ann",
      "tok-1",
      "new-secret",
    );
  });

  it("stores nothing when no password was remembered", async () => {
    credentials.loadCredential.mockResolvedValue({ username: "ann", hasPassword: false });
    const change = mountWith(vi.fn().mockResolvedValue({}));
    await change("old", "new-secret", false);
    expect(credentials.saveCredential).not.toHaveBeenCalled();
  });

  it("does not touch the store when the change is refused", async () => {
    credentials.loadCredential.mockResolvedValue({ username: "ann", hasPassword: true });
    const change = mountWith(vi.fn().mockRejectedValue(new Error("nope")));
    await expect(change("old", "new-secret", false)).rejects.toThrow("nope");
    expect(credentials.saveCredential).not.toHaveBeenCalled();
  });

  it("still reports success when the credential store cannot be read", async () => {
    credentials.loadCredential.mockRejectedValue(new Error("locked"));
    const outcome = { ok: 1 };
    const change = mountWith(vi.fn().mockResolvedValue(outcome));
    await expect(change("old", "new-secret", false)).resolves.toBe(outcome);
    expectConsole("warn", /remembered password could not be updated/);
  });
});
