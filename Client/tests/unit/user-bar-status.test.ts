import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { authStore } from "@stores/auth.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";
import { createUserBar } from "../../src/features/voice/UserBar";
import { loadUserStatus, saveUserStatus } from "@lib/presence/userStatus";
import { createPresenceSender } from "@lib/presence/presence";
import { createPresenceLimiter } from "@lib/net/rateLimiter";
import type { WsClient } from "@lib/ws";
import { resetAuthState } from "../helpers/storeSeeds";

function signIn(): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 1, username: "alice", avatar: null, role: "member", custom_status: null },
    serverName: "TestServer",
    motd: null,
    isAuthenticated: true,
  }));
}

function mockWs(): WsClient {
  return {
    send: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    getState: vi.fn(() => "connected"),
  } as unknown as WsClient;
}

describe("UserBar status dot and the one status menu", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createUserBar>;

  const q = <T extends HTMLElement>(sel: string): T | null => document.body.querySelector<T>(sel);
  const dot = (): HTMLElement => q<HTMLElement>("[data-testid='user-bar-status-dot']")!;
  const pick = (status: string): void =>
    q<HTMLButtonElement>(`[data-testid='spc-status-${status}']`)!.click();

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      comp?.destroy?.();
      setConnectionStatus("disconnected");
      resetAuthState();
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setConnectionStatus("connected");
    signIn();
  });

  function mount(ws: WsClient = mockWs()): WsClient {
    comp = createUserBar({ ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) });
    comp.mount(container);
    return ws;
  }

  it("clicking the dot opens the profile card, the same menu as the name", () => {
    mount();
    dot().click();
    expect(q("[data-testid='self-profile-card']")).not.toBeNull();
    expect(q("[data-testid='spc-clear-after']")).not.toBeNull();
  });

  it("a status picked in the card is sent and persisted, and the dot follows it", () => {
    saveUserStatus("idle");
    const ws = mount();
    expect(dot().style.background).toBe("var(--yellow)");

    dot().click();
    pick("dnd");

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = vi.mocked(ws.send).mock.calls[0]![0] as {
      type: string;
      payload: { status: string };
    };
    expect(sent.type).toBe("presence_update");
    expect(sent.payload.status).toBe("dnd");
    expect(loadUserStatus()).toBe("dnd");
    expect(dot().style.background).toBe("var(--red)");
  });

  // Every presence producer shares one sender and limiter, so a frame the
  // server's one-per-ten-seconds window would drop is queued and retried.
  it("queues (does not drop) a status change when the shared limiter's window is closed", () => {
    vi.useFakeTimers();
    try {
      const ws = mockWs();
      const presenceSender = createPresenceSender(ws, createPresenceLimiter());
      presenceSender.send("idle");
      vi.mocked(ws.send).mockClear();
      comp = createUserBar({ ws, presenceSender });
      comp.mount(container);

      dot().click();
      pick("online");
      expect(ws.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(11_000);
      expect(ws.send).toHaveBeenCalledOnce();
      const sent = vi.mocked(ws.send).mock.calls[0]![0] as { payload: { status: string } };
      expect(sent.payload.status).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a status change made elsewhere (settings Account tab)", () => {
    mount();
    saveUserStatus("dnd");
    expect(dot().style.background).toBe("var(--red)");
  });

  it("dims while the connection is down, and the card's statuses are inert", () => {
    mount();
    expect(dot().classList.contains("ub-status-dot--offline")).toBe(false);

    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(dot().classList.contains("ub-status-dot--offline")).toBe(true);

    dot().click();
    expect(q<HTMLButtonElement>("[data-testid='spc-status-idle']")!.disabled).toBe(true);
  });

  it("status controls are inert without a send path, even when connected", () => {
    comp = createUserBar({ ws: mockWs() });
    comp.mount(container);
    expect(dot().classList.contains("ub-status-dot--offline")).toBe(true);
  });

  it("the dot has a size and shape in app.css and lets clicks reach the button", () => {
    for (const prop of ["width", "height", "border-radius"]) {
      expect(
        cascadedDeclaration(".user-bar .ub-status-dot", prop),
        `.ub-status-dot needs ${prop}`,
      ).toBeDefined();
    }
    expect(keyword(cascadedDeclaration(".user-bar .ub-status-dot", "pointer-events"))).toBe("none");
  });
});
