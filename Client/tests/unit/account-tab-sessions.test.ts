import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockShowToast = vi.fn();
vi.mock("@lib/ui/toast", () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }));

import { buildAccountTab } from "../../src/features/settings/AccountTab";
import { setSessionReplaced } from "@stores/ui.store";
import type { SettingsOverlayOptions } from "../../src/features/settings/SettingsOverlay";
import { ApiClientError } from "@lib/api";
import type { OwnApiToken, SessionInfo } from "@lib/api";
import { signInAs } from "../helpers/storeSeeds";
import { makeOverlayOptions } from "../helpers/settingsOverlayOptions";

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
  return makeOverlayOptions({
    onUploadAvatar: vi.fn().mockResolvedValue(""),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "", backup_codes: [] }),
    onListSessions: vi.fn().mockResolvedValue([OTHER, CURRENT]),
    onRevokeAllSessions: vi
      .fn()
      .mockResolvedValue({ sessions_revoked: 2, current_session_revoked: true }),
    ...overrides,
  });
}

/** Fresh sign-in and abort signal per test; returns the current controller. */
function useAccountTabHarness(): () => AbortController {
  let ac = new AbortController();
  beforeEach(() => {
    ac = new AbortController();
    mockShowToast.mockClear();
    setSessionReplaced(false);
    signInAs({ id: 1, username: "alice", avatar: null, role: "member" }, { serverName: "s" });
  });
  afterEach(() => {
    ac.abort();
    document.body.replaceChildren();
  });
  return () => ac;
}

describe("Account tab — devices", () => {
  const harness = useAccountTabHarness();

  async function render(options: SettingsOverlayOptions): Promise<HTMLElement> {
    const tab = buildAccountTab(options, harness().signal);
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
        "Device signed out. Its requests are refused and its current connection is closed.",
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
    // Focus only lands on what is shown, so open the devices panel first.
    tab.querySelector<HTMLButtonElement>('[data-testid="sessions-manage"]')!.click();
    const trigger = tab.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all"]')!;
    const confirmArea = tab.querySelector<HTMLElement>(
      '[data-testid="sessions-revoke-all-confirm-area"]',
    )!;
    trigger.click();
    const cancel = [...confirmArea.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    // Opening moves focus off the hidden trigger to the safe choice.
    expect(document.activeElement).toBe(cancel);
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

const BOT: OwnApiToken = {
  id: 4,
  label: "release-bot",
  created_at: "2026-10-01 10:00:00",
  last_used: null,
  expires_at: null,
};

describe("Account tab — API tokens", () => {
  const ac = useAccountTabHarness();

  const tokenRows = (tab: HTMLElement): HTMLElement[] => [
    ...tab.querySelectorAll<HTMLElement>('[data-testid="api-token-row"]'),
  ];
  const section = (tab: HTMLElement): HTMLElement =>
    tab.querySelector<HTMLElement>('[data-testid="api-tokens-section"]')!;
  const revokeOption = (tab: HTMLElement): HTMLElement =>
    tab.querySelector<HTMLElement>('[data-testid="pw-revoke-api-tokens-row"]')!;

  async function renderWith(overrides: Partial<SettingsOverlayOptions>): Promise<HTMLElement> {
    const tab = buildAccountTab(makeOptions(overrides), ac().signal);
    document.body.appendChild(tab);
    await vi.waitFor(() => {
      expect(tab.querySelectorAll('[data-testid="session-row"]').length).toBeGreaterThan(0);
    });
    await Promise.resolve();
    return tab;
  }

  it("lists the account's tokens and ticks the revoke option on the password form", async () => {
    const tab = await renderWith({
      onListApiTokens: vi.fn().mockResolvedValue([BOT]),
      onRevokeApiToken: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    expect(section(tab).hidden).toBe(false);
    expect(tokenRows(tab)[0]!.textContent).toContain("release-bot");
    expect(tokenRows(tab)[0]!.textContent).toContain("Last used never");
    expect(revokeOption(tab).hidden).toBe(false);
    const box = tab.querySelector<HTMLInputElement>('[data-testid="pw-revoke-api-tokens"]')!;
    expect(box.checked).toBe(true);
  });

  it("hides the list and the option when the account has no tokens", async () => {
    const tab = await renderWith({
      onListApiTokens: vi.fn().mockResolvedValue([]),
      onRevokeApiToken: vi.fn(),
    });
    await Promise.resolve();
    expect(section(tab).hidden).toBe(true);
    expect(revokeOption(tab).hidden).toBe(true);
  });

  it("revokes the chosen token and removes its row", async () => {
    const onRevokeApiToken = vi.fn().mockResolvedValue(undefined);
    const tab = await renderWith({
      onListApiTokens: vi.fn().mockResolvedValue([BOT]),
      onRevokeApiToken,
    });
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    tab.querySelector<HTMLButtonElement>('[data-testid="api-token-revoke"]')!.click();
    expect(onRevokeApiToken).toHaveBeenCalledWith(4);
    await vi.waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        "API token revoked. It can no longer be used.",
        "success",
      ),
    );
    expect(tokenRows(tab)).toHaveLength(0);
    expect(section(tab).hidden).toBe(true);
  });

  it("keeps the row gone when the token was already revoked elsewhere", async () => {
    const tab = await renderWith({
      onListApiTokens: vi.fn().mockResolvedValue([BOT]),
      onRevokeApiToken: vi
        .fn()
        .mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "no active token with that id")),
    });
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    tab.querySelector<HTMLButtonElement>('[data-testid="api-token-revoke"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(tokenRows(tab)).toHaveLength(0);
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("puts the row back when the server refuses the revoke", async () => {
    const tab = await renderWith({
      onListApiTokens: vi.fn().mockResolvedValue([BOT]),
      onRevokeApiToken: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    tab.querySelector<HTMLButtonElement>('[data-testid="api-token-revoke"]')!.click();
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    expect(section(tab).hidden).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("reloads the token list after a password change that revoked the tokens", async () => {
    // The password form and the token list each read the list once on build.
    const onListApiTokens = vi
      .fn()
      .mockResolvedValueOnce([BOT])
      .mockResolvedValueOnce([BOT])
      .mockResolvedValue([]);
    const tab = await renderWith({
      onListApiTokens,
      onRevokeApiToken: vi.fn().mockResolvedValue(undefined),
      onChangePassword: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(1));
    const inputs = tab.querySelectorAll<HTMLInputElement>("#pw-old, #pw-new, #pw-confirm");
    inputs[0]!.value = "oldpass123";
    inputs[1]!.value = "newpassword123";
    inputs[2]!.value = "newpassword123";
    const changeBtn = [...tab.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Change Password",
    )!;
    changeBtn.click();
    await vi.waitFor(() => expect(tokenRows(tab)).toHaveLength(0));
    expect(section(tab).hidden).toBe(true);
    await vi.waitFor(() => expect(revokeOption(tab).hidden).toBe(true));
  });
});

describe("Account tab — devices after a sign-out or password change", () => {
  const harness = useAccountTabHarness();

  const rows = (tab: HTMLElement): string[] =>
    [...tab.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].map(
      (r) => r.dataset["sessionId"] ?? "",
    );

  it("keeps the row gone when the device was already signed out", async () => {
    const onRevokeSession = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "gone"));
    const tab = buildAccountTab(makeOptions({ onRevokeSession }), harness().signal);
    document.body.appendChild(tab);
    await vi.waitFor(() => expect(rows(tab)).toHaveLength(2));
    tab.querySelector<HTMLButtonElement>('[data-testid="session-revoke"]')!.click();
    await vi.waitFor(() => expect(onRevokeSession).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    expect(rows(tab)).toEqual([String(CURRENT.id)]);
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("reloads the device list after a password change", async () => {
    const onListSessions = vi
      .fn()
      .mockResolvedValueOnce([OTHER, CURRENT])
      .mockResolvedValue([CURRENT]);
    const options = makeOptions({
      onListSessions,
      onChangePassword: vi.fn().mockResolvedValue(undefined),
    });
    const tab = buildAccountTab(options, harness().signal);
    document.body.appendChild(tab);
    await vi.waitFor(() => expect(rows(tab)).toHaveLength(2));
    const inputs = tab.querySelectorAll<HTMLInputElement>("#pw-old, #pw-new, #pw-confirm");
    inputs[0]!.value = "oldpass123";
    inputs[1]!.value = "newpassword123";
    inputs[2]!.value = "newpassword123";
    [...tab.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Change Password")!
      .click();
    await vi.waitFor(() => expect(rows(tab)).toEqual([String(CURRENT.id)]));
  });
});
