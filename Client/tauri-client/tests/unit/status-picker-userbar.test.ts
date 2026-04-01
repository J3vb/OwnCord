import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";

vi.mock("@stores/ui.store", () => ({
  openSettings: vi.fn(),
  uiStore: { getState: () => ({}), subscribe: () => () => {} },
}));

import { createUserBar } from "@components/UserBar";
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
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
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
    comp = createUserBar({ ws });
    comp.mount(container);

    // Open picker
    const dot = container.querySelector(".status-picker-dot") as HTMLElement;
    dot.click();

    // Click the "idle" option (second option)
    const options = container.querySelectorAll(".status-picker-option");
    expect(options.length).toBe(4);
    (options[1] as HTMLElement).click(); // "Idle"

    expect(ws.send).toHaveBeenCalledOnce();
    const sentMsg = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentMsg.type).toBe("presence_update");
    expect(sentMsg.payload.status).toBe("idle");
  });

  it("status picker is disabled when WS is disconnected", () => {
    setAuthState({ username: "alice" }, true);
    const ws = createMockWs("disconnected");
    comp = createUserBar({ ws });
    comp.mount(container);

    const wrap = container.querySelector("[data-testid='status-picker-wrap']") as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.classList.contains("ub-status-picker--disabled")).toBe(true);
    expect(wrap.title).toBe("Offline");
  });
});
