import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";
import { createUserBar } from "@components/UserBar";
import {
  voiceStore,
  resetVoiceStore,
  setVoiceStates,
  joinVoiceChannel,
  leaveVoiceChannel,
  setLocalGateSpeaking,
  setLocalMuted,
  setLocalDeafened,
  setPttGated,
} from "@stores/voice.store";

vi.mock("@stores/ui.store", () => ({
  openSettings: vi.fn(),
  uiStore: {
    getState: () => ({ connectionStatus: "connected" }),
    subscribe: () => () => {},
    subscribeSelector: () => () => {},
  },
}));

function setAuthState(user: { username: string } | null, isAuthenticated: boolean): void {
  authStore.setState(() => ({
    token: isAuthenticated ? "tok" : null,
    user: user !== null ? { id: 1, username: user.username, avatar: null, role: "member" } : null,
    serverName: "TestServer",
    motd: null,
    isAuthenticated,
  }));
}

describe("UserBar", () => {
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
    // Reset auth store
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
  });

  it("mounts with user-bar class", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".user-bar")).not.toBeNull();
  });

  it("shows username from authStore", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const name = container.querySelector(".ub-name");
    expect(name?.textContent).toBe("alice");
  });

  it("shows first letter as avatar", () => {
    setAuthState({ username: "bob" }, true);
    comp = createUserBar();
    comp.mount(container);

    const avatar = container.querySelector(".ub-avatar span");
    expect(avatar?.textContent).toBe("B");
  });

  it('shows "Online" when authenticated', () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const status = container.querySelector(".ub-status");
    expect(status?.textContent).toBe("Online");
  });

  it('shows "Offline" when not authenticated', () => {
    setAuthState(null, false);
    comp = createUserBar();
    comp.mount(container);

    const status = container.querySelector(".ub-status");
    expect(status?.textContent).toBe("Offline");
  });

  it("settings button calls openSettings", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const settingsBtn = container.querySelector('[title="Settings"]') as HTMLButtonElement;
    settingsBtn.click();

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("does not render mute or deafen buttons", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector('[title="Mute"]')).toBeNull();
    expect(container.querySelector('[title="Deafen"]')).toBeNull();
  });

  it("destroy removes DOM and unsubscribes", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".user-bar")).not.toBeNull();

    comp.destroy?.();

    expect(container.querySelector(".user-bar")).toBeNull();
  });

  it("renders disconnect button when onDisconnect is provided", () => {
    setAuthState({ username: "alice" }, true);
    const onDisconnect = vi.fn();
    comp = createUserBar({ onDisconnect });
    comp.mount(container);

    const disconnectBtn = container.querySelector(
      '[data-testid="disconnect-btn"]',
    ) as HTMLButtonElement;
    expect(disconnectBtn).not.toBeNull();
    expect(disconnectBtn.getAttribute("aria-label")).toBe("Switch server");
  });

  it("calls onDisconnect when disconnect button is clicked", () => {
    setAuthState({ username: "alice" }, true);
    const onDisconnect = vi.fn();
    comp = createUserBar({ onDisconnect });
    comp.mount(container);

    const disconnectBtn = container.querySelector(
      '[data-testid="disconnect-btn"]',
    ) as HTMLButtonElement;
    disconnectBtn.click();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("does not render disconnect button when onDisconnect is not provided", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const disconnectBtn = container.querySelector('[data-testid="disconnect-btn"]');
    expect(disconnectBtn).toBeNull();
  });

  it("updates username reactively when auth store changes", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".ub-name")?.textContent).toBe("alice");

    // Update auth store with new username
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user ? { ...prev.user, username: "bob" } : null,
    }));
    authStore.flush();

    expect(container.querySelector(".ub-name")?.textContent).toBe("bob");
  });

  it('shows "Unknown" and "U" avatar when user is null', () => {
    setAuthState(null, false);
    comp = createUserBar();
    comp.mount(container);

    const name = container.querySelector(".ub-name");
    expect(name?.textContent).toBe("Unknown");

    // "Unknown".charAt(0).toUpperCase() = "U"
    const avatarSpan = container.querySelector(".ub-avatar span");
    expect(avatarSpan?.textContent).toBe("U");
  });

  it("has data-testid on root element", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const root = container.querySelector('[data-testid="user-bar"]');
    expect(root).not.toBeNull();
  });

  it("status changes from Online to Offline when logged out", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".ub-status")?.textContent).toBe("Online");

    // Simulate logout
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    authStore.flush();

    expect(container.querySelector(".ub-status")?.textContent).toBe("Offline");
  });

  it("avatar initial updates when username changes", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".ub-avatar span")?.textContent).toBe("A");

    authStore.setState((prev) => ({
      ...prev,
      user: prev.user ? { ...prev.user, username: "zara" } : null,
    }));
    authStore.flush();

    expect(container.querySelector(".ub-avatar span")?.textContent).toBe("Z");
  });

  describe("speaking ring", () => {
    const ringed = (): boolean =>
      container.querySelector(".ub-avatar")?.classList.contains("speaking") ?? false;
    /** Apply a voice-store change and deliver its notification. */
    const act = (fn: () => void): void => {
      fn();
      voiceStore.flush();
    };

    beforeEach(() => {
      setAuthState({ username: "alice" }, true);
      setVoiceStates([{ channel_id: 10, user_id: 1, muted: false, deafened: false }]);
      joinVoiceChannel(10);
      comp = createUserBar();
      comp.mount(container);
    });

    afterEach(() => {
      setLocalGateSpeaking(null);
      resetVoiceStore();
      voiceStore.flush();
    });

    it("rings the avatar while the local user speaks in voice", () => {
      expect(ringed()).toBe(false);
      act(() => setLocalGateSpeaking(true));
      expect(ringed()).toBe(true);
      act(() => setLocalGateSpeaking(false));
      expect(ringed()).toBe(false);
    });

    it("drops the ring when the user mutes, deafens or releases push-to-talk", () => {
      act(() => setLocalGateSpeaking(true));
      act(() => setLocalMuted(true));
      expect(ringed()).toBe(false);
      act(() => setLocalMuted(false));
      expect(ringed()).toBe(true);
      act(() => setLocalDeafened(true));
      expect(ringed()).toBe(false);
      act(() => setLocalDeafened(false));
      act(() => setPttGated(true));
      expect(ringed()).toBe(false);
      act(() => setPttGated(false));
      expect(ringed()).toBe(true);
    });

    it("drops the ring on leaving voice", () => {
      act(() => setLocalGateSpeaking(true));
      act(() => leaveVoiceChannel());
      expect(ringed()).toBe(false);
    });
  });
});
