import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";
import { createUserBar } from "@components/UserBar";

vi.mock("@stores/ui.store", () => ({
  openSettings: vi.fn(),
  uiStore: { getState: () => ({}), subscribe: () => () => {} },
}));

function setAuthState(
  user: { username: string } | null,
  isAuthenticated: boolean,
): void {
  authStore.setState(() => ({
    token: isAuthenticated ? "tok" : null,
    user: user !== null
      ? { id: 1, username: user.username, avatar: null, role: "member" }
      : null,
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

  it("calls onMuteToggle when mute button clicked", () => {
    setAuthState({ username: "alice" }, true);
    const onMuteToggle = vi.fn();
    comp = createUserBar({ onMuteToggle });
    comp.mount(container);

    const muteBtn = container.querySelector('[title="Mute"]') as HTMLButtonElement;
    muteBtn.click();
    expect(onMuteToggle).toHaveBeenCalledOnce();
  });

  it("calls onDeafenToggle when deafen button clicked", () => {
    setAuthState({ username: "alice" }, true);
    const onDeafenToggle = vi.fn();
    comp = createUserBar({ onDeafenToggle });
    comp.mount(container);

    const deafenBtn = container.querySelector('[title="Deafen"]') as HTMLButtonElement;
    deafenBtn.click();
    expect(onDeafenToggle).toHaveBeenCalledOnce();
  });

  it("does not throw when mute/deafen clicked without callbacks", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    const muteBtn = container.querySelector('[title="Mute"]') as HTMLButtonElement;
    const deafenBtn = container.querySelector('[title="Deafen"]') as HTMLButtonElement;
    expect(() => muteBtn.click()).not.toThrow();
    expect(() => deafenBtn.click()).not.toThrow();
  });

  it("stops responding to clicks after destroy", () => {
    setAuthState({ username: "alice" }, true);
    const onMuteToggle = vi.fn();
    comp = createUserBar({ onMuteToggle });
    comp.mount(container);

    const muteBtn = container.querySelector('[title="Mute"]') as HTMLButtonElement;
    comp.destroy?.();
    muteBtn.click();
    expect(onMuteToggle).not.toHaveBeenCalled();
  });

  it("destroy removes DOM and unsubscribes", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".user-bar")).not.toBeNull();

    comp.destroy?.();

    expect(container.querySelector(".user-bar")).toBeNull();
  });
});
