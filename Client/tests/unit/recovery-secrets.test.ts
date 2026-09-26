// B7-15b planted-secret control. A recovery kit secret, an owner-issued
// recovery credential, emergency recovery codes and the new password are
// account recovery roots. Plant known values, drive every flow that touches
// them — the API client, the settings reveal and the connect-page recovery —
// with the REAL logger at debug, and prove none of them reaches a log entry,
// the console, Web Storage, IndexedDB or the Cache API, and that none is left
// in the DOM once the user leaves the section. The logger has no redaction,
// so this is the only thing standing between a careless `log.debug(body)`
// and a secret in the persisted log files.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("../../src/lib/httpProxy", () => ({
  ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("../../src/lib/credentials", () => ({
  loadCredential: vi.fn().mockResolvedValue(null),
}));
vi.mock("@stores/ui.store", () => ({
  uiStore: {
    getState: () => ({ settingsOpen: false }),
    subscribe: () => () => {},
    subscribeSelector: vi.fn(() => () => {}),
  },
  openSettings: vi.fn(),
  closeSettings: vi.fn(),
  setTransientError: vi.fn(),
  setTheme: vi.fn(),
}));
vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));
vi.mock("@stores/auth.store", () => ({
  authStore: {
    getState: () => ({ user: { id: 1, username: "alice", totp_enabled: true } }),
    subscribeSelector: vi.fn(() => () => {}),
  },
  updateUser: vi.fn(),
}));

import { createApiClient } from "../../src/lib/api";
import { addLogListener, createLogger, setLogLevel, type LogEntry } from "../../src/lib/logger";
import { createSettingsOverlay, type SettingsOverlayOptions } from "@components/SettingsOverlay";
import { createConnectPage } from "../../src/pages/ConnectPage";

const KIT_SECRET = "PLNT-KITS-ECRE-TAAA-BBBB-CCCC-DDDD-EEEE";
const CREDENTIAL = "PLNT-CRED-ENTI-ALAA-BBBB-CCCC";
const CODES = ["PLNTA-CODEA", "PLNTB-CODEB"];
const NEW_PASSWORD = "Pl4nted-N3w-Password";
const PLANTED = [KIT_SECRET, CREDENTIAL, ...CODES, NEW_PASSWORD];

function json(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "x",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

let entries: LogEntry[];
let consoleArgs: unknown[][];
let setItemArgs: unknown[][];
let stopListening: () => void;
const idbOpen = vi.fn();
const cachesOpen = vi.fn();
let container: HTMLDivElement;

/** Every place a planted value could have leaked to, as one searchable string. */
function leakSurface(): string {
  const storage = (s: Storage): string =>
    Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join("\n");
  return JSON.stringify([
    entries,
    consoleArgs.map((args) => args.map(String)),
    setItemArgs,
    storage(localStorage),
    storage(sessionStorage),
  ]);
}

function expectNoLeak(): void {
  const surface = leakSurface();
  for (const value of PLANTED) expect(surface).not.toContain(value);
  expect(idbOpen).not.toHaveBeenCalled();
  expect(cachesOpen).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  entries = [];
  consoleArgs = [];
  setItemArgs = [];
  setLogLevel("debug");
  stopListening = addLogListener((e) => entries.push(e));
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleArgs.push(args);
    });
  }
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    ...args: [string, string]
  ) {
    setItemArgs.push(args);
  });
  vi.stubGlobal("indexedDB", { open: idbOpen });
  vi.stubGlobal("caches", { open: cachesOpen });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  stopListening();
  setLogLevel("warn");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recovery secrets never reach a log, storage or a lingering DOM node", () => {
  it("negative control: the detector sees a planted secret that IS logged", () => {
    createLogger("control").debug("oops", { body: { kit_secret: KIT_SECRET } });
    expect(leakSurface()).toContain(KIT_SECRET);
    entries = [];
    consoleArgs = [];
    localStorage.setItem("control", CODES[0]!);
    expect(leakSurface()).toContain(CODES[0]);
  });

  it("the API client sends and receives them without logging them", async () => {
    const api = createApiClient({ host: "chat.example", token: "t" });
    mockFetch.mockResolvedValueOnce(json({ kit_secret: KIT_SECRET, created_at: "x" }));
    await api.enrolRecoveryKit(NEW_PASSWORD);
    mockFetch.mockResolvedValueOnce(json({ backup_codes: CODES }));
    await api.regenerateRecoveryCodes(NEW_PASSWORD);
    mockFetch.mockResolvedValueOnce(json({ token: "t2", requires_2fa: false }));
    await api.recoverAccount("alice", KIT_SECRET, NEW_PASSWORD);
    // A refused attempt takes the warn path, which logs the error body.
    mockFetch.mockResolvedValueOnce(json({ error: "UNAUTHORIZED", message: "invalid" }, 401));
    await expect(api.recoverAccount("alice", CREDENTIAL, NEW_PASSWORD)).rejects.toThrow();
    mockFetch.mockResolvedValueOnce(json({ error: "UNAUTHORIZED", message: "invalid" }, 401));
    await expect(api.verifyTotp(CODES[0]!, "partial")).rejects.toThrow();

    // The logger did run on every request — the check is not vacuous.
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expectNoLeak();
  });

  it("the settings reveal shows them once and leaves nothing behind", async () => {
    const options = {
      onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
      onEnrolRecoveryKit: vi.fn().mockResolvedValue({ kit_secret: KIT_SECRET, created_at: "x" }),
      onRegenerateRecoveryCodes: vi.fn().mockResolvedValue(CODES),
      onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
      onListSessions: vi.fn().mockResolvedValue([]),
    } as unknown as SettingsOverlayOptions;
    const overlay = createSettingsOverlay(options);
    overlay.mount(container);
    overlay.open();
    const click = (id: string): void =>
      container.querySelector<HTMLButtonElement>(`[data-testid='${id}']`)!.click();
    const type = (id: string, v: string): void => {
      container.querySelector<HTMLInputElement>(`[data-testid='${id}']`)!.value = v;
    };
    click("recovery-kit-btn");
    type("recovery-kit-password", NEW_PASSWORD);
    click("recovery-kit-submit");
    click("totp-regenerate-btn");
    type("totp-regenerate-password", NEW_PASSWORD);
    click("totp-regenerate-submit");
    await vi.waitFor(() => {
      expect(container.textContent).toContain(KIT_SECRET);
      expect(container.textContent).toContain(CODES[1]);
    });

    overlay.close();
    expect(container.innerHTML).not.toContain(KIT_SECRET);
    for (const code of CODES) expect(container.innerHTML).not.toContain(code);
    // Password inputs are cleared as soon as they are read.
    for (const input of container.querySelectorAll("input")) {
      expect(input.value).not.toBe(NEW_PASSWORD);
    }
    expectNoLeak();
    overlay.destroy?.();
  });

  it("the connect-page recovery and 2FA flows do not log what was typed", async () => {
    const page = createConnectPage(
      {
        onLogin: vi.fn(),
        onLoginWithSavedPassword: vi.fn(),
        onRegister: vi.fn(),
        onTotpSubmit: vi.fn().mockRejectedValue(new Error("invalid two-factor code")),
        onRecover: vi.fn().mockRejectedValue(new Error("invalid credentials")),
      },
      [{ name: "Test", host: "chat.example" }],
    );
    page.mount(container);
    const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T;
    $<HTMLInputElement>("#host").value = "chat.example";
    $<HTMLAnchorElement>("[data-testid='recover-account-link']").click();
    await vi.waitFor(() => expect($("#recover-secret")).not.toBeNull());
    $<HTMLInputElement>("#recover-username").value = "alice";
    $<HTMLInputElement>("#recover-secret").value = CREDENTIAL;
    $<HTMLInputElement>("#recover-password").value = NEW_PASSWORD;
    $<HTMLButtonElement>("[data-testid='recover-submit']").click();
    await vi.waitFor(() =>
      expect($("[data-testid='recover-error']").textContent).toBe("invalid credentials"),
    );
    $<HTMLButtonElement>("[data-testid='recover-cancel']").click();

    page.showTotp();
    const totp = $<HTMLInputElement>(".totp-overlay input");
    totp.value = CODES[0]!;
    $<HTMLButtonElement>(".totp-overlay .btn-primary").click();
    await vi.waitFor(() => expect(container.textContent).toContain("invalid two-factor code"));

    expect(container.innerHTML).not.toContain(CREDENTIAL);
    expect($<HTMLInputElement>("#recover-secret").value).toBe("");
    expect($<HTMLInputElement>("#recover-password").value).toBe("");
    expectNoLeak();
    page.destroy?.();
  });
});
