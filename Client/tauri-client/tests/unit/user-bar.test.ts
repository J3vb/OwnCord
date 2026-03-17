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

  it("destroy removes DOM and unsubscribes", () => {
    setAuthState({ username: "alice" }, true);
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector(".user-bar")).not.toBeNull();

    comp.destroy?.();

    expect(container.querySelector(".user-bar")).toBeNull();
  });
});
