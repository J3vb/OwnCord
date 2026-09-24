import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockShowToast = vi.fn();
vi.mock("@lib/toast", () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }));

import { buildAccountTab } from "@components/settings/AccountTab";
import { authStore } from "@stores/auth.store";
import { setSessionReplaced } from "@stores/ui.store";
import type { SettingsOverlayOptions } from "@components/SettingsOverlay";
import type { SessionInfo } from "@lib/api";

// B7-14: the Account tab lists every signed-in device, signs one out by id,
// and signs out everywhere behind a confirmation that says this device is
// included.

const CURRENT: SessionInfo = {
  id: 7,
  device: "OwnCord-Client/1.4.0",
  ip: "203.0.113.5",
  created_at: "2026-09-20 10:00:00",
  last_used: "2026-09-21 09:00:00",
  is_current: true,
  unseen: true,
};
const OTHER: SessionInfo = {
  id: 9,
  device: "tauri-plugin-http/2.6.0",
  ip: "198.51.100.2",
  created_at: "2026-09-21 08:00:00",
  last_used: "2026-09-21 08:30:00",
  is_current: false,
  unseen: false,
};

function makeOptions(overrides?: Partial<SettingsOverlayOptions>): SettingsOverlayOptions {
  return {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue(""),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "", backup_codes: [] }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
    onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
    onRegenerateRecoveryCodes: vi.fn().mockResolvedValue([]),
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "" }),
    onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
    onListSessions: vi.fn().mockResolvedValue([OTHER, CURRENT]),
    onRevokeSession: vi.fn().mockResolvedValue(undefined),
    onRevokeAllSessions: vi
      .fn()
      .mockResolvedValue({ sessions_revoked: 2, current_session_revoked: true }),
    ...overrides,
  };
}

describe("Account tab — devices", () => {
  let ac: AbortController;

  beforeEach(() => {
    ac = new AbortController();
    mockShowToast.mockClear();
    setSessionReplaced(false);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "alice", avatar: null, role: "member" },
      serverName: "s",
      motd: null,
      isAuthenticated: true,
    }));
  });

  afterEach(() => {
    ac.abort();
    document.body.replaceChildren();
  });

  async function render(options: SettingsOverlayOptions): Promise<HTMLElement> {
    const tab = buildAccountTab(options, ac.signal);
    document.body.appendChild(tab);
    await vi.waitFor(() => {
      expect(tab.querySelectorAll('[data-testid="session-row"]').length).toBeGreaterThan(0);
    });
    return tab;
  }

  const rows = (tab: HTMLElement): HTMLElement[] => [
    ...tab.querySelectorAll<HTMLElement>('[data-testid="session-row"]'),
  ];

  it("lists every device with its label, IP and last use, and marks this one", async () => {
    const tab = await render(makeOptions());
    const [other, current] = rows(tab);
    expect(other!.textContent).toContain("OwnCord desktop");
    expect(other!.textContent).toContain("198.51.100.2");
    expect(other!.textContent).toContain("Last used");
    expect(other!.textContent).not.toContain("This device");
    expect(current!.textContent).toContain("203.0.113.5");
    expect(current!.textContent).toContain("This device");
  });

  it("offers no per-row sign-out on the current device", async () => {
    const tab = await render(makeOptions());
    const [other, current] = rows(tab);
    expect(other!.querySelector('[data-testid="session-revoke"]')).not.toBeNull();
    expect(current!.querySelector('[data-testid="session-revoke"]')).toBeNull();
  });

  it("signs out only the chosen device and removes its row", async () => {
    const options = makeOptions();
    const tab = await render(options);
    rows(tab)[0]!.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();

    expect(options.onRevokeSession).toHaveBeenCalledExactlyOnceWith(OTHER.id);
    expect(rows(tab).map((r) => r.dataset["sessionId"])).toEqual([String(CURRENT.id)]);
    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "Device signed out. It can no longer connect.",
        "success",
      );
    });
  });

  it("puts the row back when the server refuses the sign-out", async () => {
    const options = makeOptions({ onRevokeSession: vi.fn().mockRejectedValue(new Error("nope")) });
    const tab = await render(options);
    rows(tab)[0]!.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("nope", "error");
    });
    expect(rows(tab).map((r) => r.dataset["sessionId"])).toEqual([
      String(OTHER.id),
      String(CURRENT.id),
    ]);
  });

  it("says the connection closes shortly when a device signed in elsewhere revokes", async () => {
    setSessionReplaced(true);
    const tab = await render(makeOptions());
    rows(tab)[0]!.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "Device signed out. Its requests are refused now, and its current connection closes within about 30 seconds.",
        "success",
      );
    });
  });

  it("puts both rows back when two sign-outs in a row both fail", async () => {
    const SECOND: SessionInfo = { ...OTHER, id: 11, ip: "198.51.100.3" };
    const options = makeOptions({
      onListSessions: vi.fn().mockResolvedValue([OTHER, SECOND, CURRENT]),
      onRevokeSession: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const tab = await render(options);
    rows(tab)[0]!.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();
    rows(tab)[0]!.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledTimes(2);
    });
    expect(mockShowToast).toHaveBeenCalledWith("offline", "error");
    expect(
      rows(tab)
        .map((r) => r.dataset["sessionId"])
        .sort(),
    ).toEqual([String(OTHER.id), String(SECOND.id), String(CURRENT.id)].sort());
  });

  it("signs out everywhere only after a confirmation that says this device is included", async () => {
    const options = makeOptions();
    const tab = await render(options);
    const confirmArea = tab.querySelector<HTMLElement>(
      '[data-testid="sessions-revoke-all-confirm-area"]',
    )!;
    expect(confirmArea.style.display).toBe("none");

    tab.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all"]')!.click();
    expect(options.onRevokeAllSessions).not.toHaveBeenCalled();
    expect(confirmArea.style.display).toBe("block");
    expect(confirmArea.textContent).toContain("including this one");

    tab.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all-confirm"]')!.click();
    expect(options.onRevokeAllSessions).toHaveBeenCalledOnce();
    expect(options.onRevokeSession).not.toHaveBeenCalled();
  });

  it("hands focus back to the trigger when the confirmation is cancelled", async () => {
    const tab = await render(makeOptions());
    const trigger = tab.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all"]')!;
    const confirmArea = tab.querySelector<HTMLElement>(
      '[data-testid="sessions-revoke-all-confirm-area"]',
    )!;
    trigger.click();
    const cancel = [...confirmArea.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    cancel.focus();
    cancel.click();
    expect(confirmArea.style.display).toBe("none");
    expect(document.activeElement).toBe(trigger);
  });

  it("shows an unknown device plainly", async () => {
    const tab = await render(
      makeOptions({
        onListSessions: vi.fn().mockResolvedValue([{ ...OTHER, device: "", ip: "" }]),
      }),
    );
    expect(rows(tab)[0]!.textContent).toContain("Unknown device");
    expect(rows(tab)[0]!.textContent).toContain("Unknown IP");
  });
});
