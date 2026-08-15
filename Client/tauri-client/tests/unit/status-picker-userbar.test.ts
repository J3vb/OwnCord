// Read from disk rather than `import ... ?raw`: vitest stubs CSS modules
// (its `css: false` default), which wins over the `?raw` suffix and yields an
// empty string. A .ts source can use `?raw`; a stylesheet cannot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";

import { createUserBar } from "@components/UserBar";
import { loadUserStatus, saveUserStatus } from "@lib/userStatus";
import { createPresenceSender } from "@lib/presence";
import { createPresenceLimiter } from "@lib/rate-limiter";
import type { WsClient } from "@lib/ws";

function setAuthState(user: { username: string } | null, isAuthenticated: boolean): void {
  authStore.setState(() => ({
    token: isAuthenticated ? "tok" : null,
    user: user !== null ? { id: 1, username: user.username, avatar: null, role: "member" } : null,
    serverName: "TestServer",
    motd: null,
    isAuthenticated,
  }));
}

/** A ws plus a real (unconsumed) presence sender bound to it — what
 *  SidebarArea actually threads into UserBar in production. */
function userBarOptsWithPresence(
  ws: WsClient,
): { ws: WsClient; presenceSender: ReturnType<typeof createPresenceSender> } {
  return { ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) };
}

function createMockWs(state: "connected" | "disconnected" = "connected"): WsClient {
  let currentState = state;
  const stateListeners = new Set<(s: string) => void>();
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    onStateChange: vi.fn((listener: (s: string) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
    startCertListener: vi.fn().mockResolvedValue(undefined),
    onCertFirstUse: vi.fn().mockReturnValue(() => {}),
    onCertMismatch: vi.fn().mockReturnValue(() => {}),
    acceptCertFingerprint: vi.fn(),
    getState: vi.fn(() => currentState),
    isReplaying: vi.fn(() => false),
    _getWs: vi.fn(() => null),
    _setState(s: "connected" | "disconnected") {
      currentState = s;
      for (const l of stateListeners) l(s);
    },
  } as unknown as WsClient & { _setState(s: string): void };
}

describe("StatusPicker wired to UserBar", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createUserBar>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    localStorage.clear();
    // The picker gates on the store-backed connection status (UX spec §3).
    setConnectionStatus("connected");
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
    setConnectionStatus("disconnected");
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
  });

  it("click on status picker dot opens the dropdown", () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("connected");
    comp = createUserBar({ ws });
    comp.mount(container);

    const dot = container.querySelector(".status-picker-dot") as HTMLElement;
    expect(dot).not.toBeNull();
    dot.click();

    const dropdown = container.querySelector(".status-picker-dropdown--open");
    expect(dropdown).not.toBeNull();
  });

  it("selecting a status sends presence_update WS message", () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("connected");
    comp = createUserBar(userBarOptsWithPresence(ws));
    comp.mount(container);

    // Open picker
    const dot = container.querySelector(".status-picker-dot") as HTMLElement;
    dot.click();

    // Click the "idle" option (second option)
    const options = container.querySelectorAll(".status-picker-option");
    expect(options.length).toBe(4);
    (options[1] as HTMLElement).click(); // "Idle"

    expect(ws.send).toHaveBeenCalledOnce();
    const sentMsg = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sentMsg.type).toBe("presence_update");
    expect(sentMsg.payload.status).toBe("idle");
  });

  // OC-0210: every other presence producer (auto-idle, the settings Account
  // tab) shares one PresenceSender/RateLimiter through MainPage so a frame
  // the server's 1-per-10s presence limiter (service/channel.go) drops gets
  // retried instead of lost. The UserBar picker must go through that same
  // shared sender, not straight to ws.send, or a token another producer just
  // spent makes the server silently drop the picker's frame with nothing to
  // correct it.
  it("queues (does not drop) a status change when the shared presence limiter's window is already closed", () => {
    setAuthState({ username: "alice" }, true);
    vi.useFakeTimers();
    try {
      const ws = createMockWs("connected");
      // The same PresenceSender instance MainPage threads to every producer
      // — pre-spend its single token exactly as auto-idle or the settings
      // tab would moments before the user opens the picker.
      const presenceSender = createPresenceSender(ws, createPresenceLimiter());
      presenceSender.send("idle");
      expect(ws.send).toHaveBeenCalledOnce();
      (ws.send as ReturnType<typeof vi.fn>).mockClear();

      comp = createUserBar({ ws, presenceSender });
      comp.mount(container);

      const dot = container.querySelector(".status-picker-dot") as HTMLElement;
      dot.click();
      const options = container.querySelectorAll(".status-picker-option");
      (options[0] as HTMLElement).click(); // "Online"

      // The server's window is still closed — the frame must be queued, not
      // sent straight down the socket and lost if it's rejected.
      expect(ws.send).not.toHaveBeenCalled();

      // Once the window reopens, the queued change must still go out.
      vi.advanceTimersByTime(10_000);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMsg = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sentMsg.type).toBe("presence_update");
      expect(sentMsg.payload.status).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("status picker is disabled when WS is disconnected", () => {
    setAuthState({ username: "alice" }, true);
    setConnectionStatus("disconnected");
    const ws = createMockWs("disconnected");
    comp = createUserBar({ ws });
    comp.mount(container);

    const wrap = container.querySelector("[data-testid='status-picker-wrap']") as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.classList.contains("ub-status-picker--disabled")).toBe(true);
    expect(wrap.title).toBe("Offline");
  });

  it("status picker reacts to a connection status change through the store", async () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("connected");
    comp = createUserBar(userBarOptsWithPresence(ws));
    comp.mount(container);

    const wrap = container.querySelector("[data-testid='status-picker-wrap']") as HTMLElement;
    expect(wrap.classList.contains("ub-status-picker--disabled")).toBe(false);

    setConnectionStatus("reconnecting");
    uiStore.flush();

    expect(wrap.classList.contains("ub-status-picker--disabled")).toBe(true);
    expect(wrap.title).toBe("Offline");
  });

  it("starts from the stored status instead of always 'online'", () => {
    setAuthState({ username: "alice" }, true);
    saveUserStatus("dnd");
    const ws = createMockWs("connected");
    comp = createUserBar({ ws });
    comp.mount(container);

    const dot = container.querySelector(".status-picker-dot") as HTMLElement;
    dot.click();
    const checks = container.querySelectorAll(".status-picker-option-check");
    // Third option is "Do Not Disturb" — only its checkmark is visible.
    expect((checks[2] as HTMLElement).style.display).toBe("");
    expect((checks[0] as HTMLElement).style.display).toBe("none");
  });

  it("persists the selected status so the settings panel agrees", () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("connected");
    comp = createUserBar({ ws });
    comp.mount(container);

    (container.querySelector(".status-picker-dot") as HTMLElement).click();
    const options = container.querySelectorAll(".status-picker-option");
    (options[1] as HTMLElement).click(); // "Idle"

    expect(loadUserStatus()).toBe("idle");
  });

  it("follows a status change made elsewhere (settings Account tab)", () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("connected");
    comp = createUserBar({ ws });
    comp.mount(container);

    const dot = container.querySelector(".status-picker-dot") as HTMLElement;
    dot.click();

    saveUserStatus("dnd");

    const checks = container.querySelectorAll(".status-picker-option-check");
    expect((checks[2] as HTMLElement).style.display).toBe("");
  });

  it("status picker is disabled without a ws send path even when connected", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar({});
    comp.mount(container);

    // Without a ws client, selecting a status would be a silent no-op —
    // the control stays disabled instead (no-silent-failure principle).
    const wrap = container.querySelector("[data-testid='status-picker-wrap']") as HTMLElement;
    expect(wrap.classList.contains("ub-status-picker--disabled")).toBe(true);
  });

  // jsdom never applies app.css, so a computed-style assertion here would
  // pass whether or not the rules exist. Instead this pins the CSS *source*
  // to the classes StatusPicker.ts actually emits, so a future edit that
  // renames/deletes one side without the other goes red immediately (this
  // is exactly how the trigger dot went invisible: the rules were deleted
  // but the component still emitted the old names).
  it("every class StatusPicker.ts emits has a rule in app.css, and both dots have an explicit size", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

    const ruleBody = (selector: string): string => {
      const match = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css);
      expect(match, `expected a \`.${selector} { ... }\` rule in app.css`).not.toBeNull();
      return match![1]!;
    };

    ruleBody("status-picker-option");
    ruleBody("status-picker-option-label");
    ruleBody("status-picker-option-check");

    // The dot and option-dot are bare elements whose only inline style is
    // `background` (StatusPicker.ts) -- without an explicit size in CSS
    // they collapse to 0x0 and are invisible/unclickable.
    for (const dotSelector of ["status-picker-dot", "status-picker-option-dot"]) {
      const body = ruleBody(dotSelector);
      expect(body, `${dotSelector} needs an explicit width`).toMatch(/width\s*:/);
      expect(body, `${dotSelector} needs an explicit height`).toMatch(/height\s*:/);
      expect(body, `${dotSelector} needs a border-radius to render as a dot`).toMatch(
        /border-radius\s*:/,
      );
    }
  });

  // UserBar's updatePickerDisabled toggles ub-status-picker--disabled on the
  // wrap element whenever canSetStatus() is false, but that class has no
  // effect at all unless app.css actually makes it inert -- otherwise the
  // dropdown and its custom-status input stay fully clickable while the
  // socket is down, and anything typed there is silently dropped (never sent
  // now, never re-sent on reconnect since restoreSavedPresence only re-sends
  // `status`, not `custom_status`).
  it("ub-status-picker--disabled actually disables the picker in app.css", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");
    const match = /\.ub-status-picker--disabled\s*\{([^}]*)\}/.exec(css);
    expect(
      match,
      "expected a `.ub-status-picker--disabled { ... }` rule in app.css",
    ).not.toBeNull();
    expect(match![1], "disabled state must reject pointer input").toMatch(
      /pointer-events\s*:\s*none/,
    );
  });
});
