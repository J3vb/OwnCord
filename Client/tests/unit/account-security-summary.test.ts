// Account tab, settings UX clarity pass: security state first, forms on demand.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockAuthState = vi.hoisted(() => ({
  user: { id: 1, username: "testuser", totp_enabled: false, display_name: null as string | null },
}));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => mockAuthState, subscribeSelector: vi.fn(() => () => {}) },
  updateUser: vi.fn(),
}));
vi.mock("@stores/ui.store", () => ({
  uiStore: { getState: () => ({ sessionReplaced: false }), subscribe: () => () => {} },
}));

import { buildAccountTab } from "@components/settings/AccountTab";

function session(id: number, current: boolean) {
  return {
    id,
    device: "OwnCord desktop",
    ip: "127.0.0.1",
    last_used: "2026-09-27T12:00:00Z",
    is_current: current,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/test"),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "otpauth://test", backup_codes: [] }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
    onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
    onRegenerateRecoveryCodes: vi.fn().mockResolvedValue([]),
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "" }),
    onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
    onListSessions: vi.fn().mockResolvedValue([session(1, true), session(2, false)]),
    onRevokeSession: vi.fn().mockResolvedValue(undefined),
    onRevokeAllSessions: vi
      .fn()
      .mockResolvedValue({ sessions_revoked: 0, current_session_revoked: false }),
    ...overrides,
  } as unknown as Parameters<typeof buildAccountTab>[0];
}

/** Only what is on screen: a form not yet opened is hidden or display:none. */
function shown(el: HTMLElement | null): boolean {
  for (let n = el; n !== null; n = n.parentElement) {
    if (n.hidden || n.style.display === "none") return false;
  }
  return true;
}

/** The accent-filled actions on screen under `root`. */
function accentIn(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button.ac-btn")]
    .filter((b) => !b.classList.contains("secondary") && shown(b))
    .map((b) => b.textContent);
}

function sessions(count: number) {
  return Array.from({ length: count }, (_, i) => session(i + 1, i === 0));
}

describe("Account tab: security summary", () => {
  let ac: AbortController;
  let pane: HTMLDivElement;

  const card = () => pane.querySelector<HTMLElement>("[data-testid='security-card']")!;
  const row = (testId: string) => card().querySelector<HTMLElement>(`[data-testid='${testId}']`)!;
  const pill = () => card().querySelector<HTMLElement>("[data-testid='security-summary']")!;

  function mount(opts = options()): void {
    pane = buildAccountTab(opts, ac.signal);
    document.body.appendChild(pane);
  }

  beforeEach(() => {
    ac = new AbortController();
    localStorage.clear();
    mockAuthState.user.totp_enabled = false;
  });
  afterEach(() => {
    ac.abort();
    pane.remove();
  });

  it("gathers two-factor, recovery kit, password and devices as rows of one Security card", async () => {
    mount();
    expect(card().querySelector("h3")!.textContent).toBe("Security");
    const names = [...card().querySelectorAll(".status-item > .status-name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual([
      "Two-factor authentication",
      "Recovery kit",
      "Password",
      "Signed-in devices",
    ]);
  });

  it("warns, in words, about two-factor off and no recovery kit, and counts the steps", async () => {
    mount();
    await vi.waitFor(() => expect(row("recovery-kit-section").textContent).toContain("Not set up"));
    const totp = row("totp-section");
    expect(totp.querySelector(":scope > .st-ic.st-warn")).not.toBeNull();
    expect(totp.querySelector(".status-result")!.textContent).toContain("Disabled");
    expect(totp.querySelector(".status-result")!.textContent).toContain(
      "anyone with your password can sign in",
    );
    expect(row("recovery-kit-section").querySelector(":scope > .st-ic.st-warn")).not.toBeNull();
    expect(pill().textContent).toBe("2 recommended steps");
    expect(pill().querySelector(".st-ic.st-warn")).not.toBeNull();
  });

  it("says all set when two-factor is on and a kit is enrolled", async () => {
    mockAuthState.user.totp_enabled = true;
    mount(
      options({
        onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: true, used_at: null }),
      }),
    );
    await vi.waitFor(() => expect(pill().textContent).toBe("All set"));
    expect(pill().querySelector(".st-ic.st-ok")).not.toBeNull();
    expect(row("totp-section").querySelector(":scope > .st-ic.st-ok")).not.toBeNull();
    expect(row("recovery-kit-section").querySelector(":scope > .st-ic.st-ok")).not.toBeNull();
  });

  it("gives the Security card one accent action: turning on two-factor", async () => {
    mount(options({ onListSessions: vi.fn().mockResolvedValue(sessions(4)) }));
    await vi.waitFor(() => expect(row("recovery-kit-section").textContent).toContain("Not set up"));
    expect(accentIn(card())).toEqual(["Enable 2FA"]);
    // Still one with the device list open: each device's sign out is secondary.
    await vi.waitFor(() =>
      expect(card().querySelectorAll("[data-testid='session-revoke']")).toHaveLength(3),
    );
    row("sessions-section")
      .querySelector<HTMLButtonElement>("[data-testid='sessions-manage']")!
      .click();
    expect(accentIn(card())).toEqual(["Enable 2FA"]);
  });

  it("rests destructive actions quietly and fills them only once armed", async () => {
    mockAuthState.user.totp_enabled = true;
    mount(
      options({
        onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: true, used_at: null }),
        onListSessions: vi.fn().mockResolvedValue(sessions(4)),
      }),
    );
    await vi.waitFor(() => expect(pill().textContent).toBe("All set"));
    await vi.waitFor(() =>
      expect(card().querySelectorAll("[data-testid='session-revoke']")).toHaveLength(3),
    );
    row("sessions-section")
      .querySelector<HTMLButtonElement>("[data-testid='sessions-manage']")!
      .click();
    // All set: nothing is recommended, so nothing is accent or filled red.
    expect(accentIn(card())).toEqual([]);
    const btn = (testId: string) =>
      card().querySelector<HTMLButtonElement>(`[data-testid='${testId}']`)!;
    const filled = [...card().querySelectorAll<HTMLElement>(".account-delete-btn")].filter(shown);
    expect(filled).toEqual([]);
    for (const testId of ["totp-disable-btn", "sessions-revoke-all"]) {
      expect(btn(testId).classList.contains("secondary")).toBe(true);
      expect(btn(testId).classList.contains("destructive")).toBe(true);
    }
    for (const signOut of card().querySelectorAll("[data-testid='session-revoke']")) {
      expect(signOut.classList.contains("secondary")).toBe(true);
      expect(signOut.classList.contains("destructive")).toBe(false);
    }

    btn("totp-disable-btn").click();
    btn("sessions-revoke-all").click();
    const armed = [...card().querySelectorAll<HTMLElement>(".account-delete-btn")].filter(shown);
    expect(armed.map((b) => b.textContent)).toEqual(["Confirm Disable", "Sign out everywhere"]);
  });

  it("keeps the change-password form closed until Change… opens it", () => {
    mount();
    const toggle = row("password-section").querySelector<HTMLButtonElement>(
      "[data-testid='password-change-toggle']",
    )!;
    expect(toggle.textContent).toBe("Change…");
    expect(toggle.classList.contains("secondary")).toBe(true);
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel.contains(pane.querySelector("#pw-old"))).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
  });

  it("counts signed-in devices and lists them only on Manage", async () => {
    mount();
    const devices = row("sessions-section");
    await vi.waitFor(() =>
      expect(devices.querySelector(".status-result")!.textContent).toBe("2 devices"),
    );
    const manage = devices.querySelector<HTMLButtonElement>("[data-testid='sessions-manage']")!;
    const panel = document.getElementById(manage.getAttribute("aria-controls")!)!;
    expect(panel.contains(pane.querySelector("[data-testid='sessions-list']"))).toBe(true);
    expect(panel.hidden).toBe(true);
    manage.click();
    expect(panel.hidden).toBe(false);
  });

  it("recounts signed-in devices after one is signed out", async () => {
    mount(options({ onListSessions: vi.fn().mockResolvedValue(sessions(3)) }));
    const result = () => row("sessions-section").querySelector(".status-result")!.textContent;
    await vi.waitFor(() => expect(result()).toBe("3 devices"));
    card().querySelector<HTMLButtonElement>("[data-testid='session-revoke']")!.click();
    await vi.waitFor(() => expect(result()).toBe("2 devices"));
  });
});

describe("Account tab: profile strip", () => {
  let ac: AbortController;
  let pane: HTMLDivElement;

  beforeEach(() => {
    ac = new AbortController();
    localStorage.clear();
  });
  afterEach(() => {
    ac.abort();
    pane.remove();
  });

  it("opens avatar, display name, about and username editing from one Edit profile action", () => {
    pane = buildAccountTab(options(), ac.signal);
    document.body.appendChild(pane);
    const profile = pane.querySelector<HTMLElement>(".account-card")!;
    const edit = profile.querySelector<HTMLButtonElement>("[data-testid='profile-edit-toggle']")!;
    const editor = document.getElementById(edit.getAttribute("aria-controls")!)!;
    const inEditor = (selector: string) => editor.contains(pane.querySelector(selector));

    // At rest the card offers one action, and it is the accent.
    const onScreen = [...profile.querySelectorAll<HTMLButtonElement>("button")].filter(shown);
    expect(onScreen.map((b) => b.textContent)).toEqual(["Edit profile"]);
    expect(accentIn(profile)).toEqual(["Edit profile"]);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    for (const testId of ["avatar-upload-btn", "display-name-input", "about-input"]) {
      expect(inEditor(`[data-testid='${testId}']`)).toBe(true);
    }
    expect(inEditor(".account-field-edit")).toBe(true);
    expect(inEditor("[data-testid='username-edit-input']")).toBe(true);

    // Open, Save Profile takes the accent, also with the username form open.
    edit.click();
    expect(editor.hidden).toBe(false);
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(accentIn(profile)).toEqual(["Save Profile"]);
    profile.querySelector<HTMLButtonElement>(".account-field-edit")!.click();
    expect(shown(pane.querySelector("[data-testid='username-edit-input']"))).toBe(true);
    expect(accentIn(profile)).toEqual(["Save Profile"]);

    edit.click();
    expect(editor.hidden).toBe(true);
    expect(accentIn(profile)).toEqual(["Edit profile"]);
  });
});

describe("Account tab: status and danger zone", () => {
  let ac: AbortController;
  let pane: HTMLDivElement;

  beforeEach(() => {
    ac = new AbortController();
    localStorage.clear();
  });
  afterEach(() => {
    ac.abort();
    pane.remove();
  });

  it("chooses the status from one labelled select that saves and reports the change", () => {
    const opts = options();
    pane = buildAccountTab(opts, ac.signal);
    document.body.appendChild(pane);
    const select = pane.querySelector<HTMLSelectElement>("select[data-testid='status-select']")!;
    expect(select.labels![0]!.textContent).toBe("Show me as");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Online",
      "Idle",
      "Do Not Disturb",
      "Invisible",
    ]);
    expect(select.value).toBe("online");
    select.value = "dnd";
    select.dispatchEvent(new Event("change"));
    expect(opts.onStatusChange).toHaveBeenCalledWith("dnd");
    expect(localStorage.getItem("owncord:settings:userStatus")).toBe(JSON.stringify("dnd"));
    expect(pane.textContent).toContain("Do Not Disturb also silences desktop notifications");
  });

  it("keeps account deletion behind a closed disclosure", () => {
    pane = buildAccountTab(options(), ac.signal);
    const danger = [...pane.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")!.textContent!.startsWith("Delete account"),
    );
    expect(danger).toBeDefined();
    expect(danger!.open).toBe(false);
    expect(danger!.querySelector(".account-delete-btn")).not.toBeNull();
  });

  it("makes Change Avatar a secondary action", () => {
    pane = buildAccountTab(options(), ac.signal);
    const avatar = [...pane.querySelectorAll("button")].find(
      (b) => b.textContent === "Change Avatar",
    )!;
    expect(avatar.classList.contains("secondary")).toBe(true);
  });
});
