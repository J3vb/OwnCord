import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchImageAsDataUrl = vi.hoisted(() => vi.fn());

// Only the network fetch is stubbed -- isSafeUrl/resolveServerUrl are
// reimplemented (not mocked away) so the raw-src-vs-authenticated-fetch
// distinction this suite exercises stays honest. Mirrors tests/unit/avatar.test.ts.
vi.mock("@components/message-list/attachments", () => ({
  fetchImageAsDataUrl,
  isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

import { createDmProfileSidebar } from "../../src/components/DmProfileSidebar";
import type { DmProfileData, DmProfileSidebarOptions } from "../../src/components/DmProfileSidebar";

const makeUser = (overrides: Partial<DmProfileData> = {}): DmProfileData => ({
  id: 1,
  username: "Alice",
  avatar: null,
  status: "online",
  about: "Hello world",
  joinDate: "Jan 1, 2025",
  ...overrides,
});

function makeOptions(overrides: Partial<DmProfileSidebarOptions> = {}): DmProfileSidebarOptions {
  return {
    user: makeUser(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("DmProfileSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    fetchImageAsDataUrl.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  // -------------------------------------------------------------------------
  // Test 1: Clicking DM header opens/closes the sidebar (toggle behavior)
  // -------------------------------------------------------------------------
  it("opens on mount and closes via onClose callback (toggle behavior)", () => {
    const onClose = vi.fn();
    const sidebar = createDmProfileSidebar({ user: makeUser(), onClose });

    // Mount opens the sidebar
    sidebar.mount(container);
    expect(sidebar.isOpen()).toBe(true);

    const panel = container.querySelector('[data-testid="dm-profile-sidebar"]');
    expect(panel).not.toBeNull();

    // Click the close button to close
    const closeBtn = container.querySelector('[data-testid="dps-close"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(onClose).toHaveBeenCalledOnce();

    // Calling destroy closes the panel
    sidebar.destroy?.();
    expect(sidebar.isOpen()).toBe(false);
    expect(container.querySelector('[data-testid="dm-profile-sidebar"]')).toBeNull();
  });

  it("closes when Escape key is pressed", () => {
    const onClose = vi.fn();
    const sidebar = createDmProfileSidebar({ user: makeUser(), onClose });
    sidebar.mount(container);

    expect(sidebar.isOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledOnce();

    sidebar.destroy?.();
  });

  // -------------------------------------------------------------------------
  // OC-0264: the DM header (dmDisplayName) prefers the nickname, so the
  // profile panel it opens must show the same identity -- both the title and
  // the avatar-fallback initial -- rather than falling back to the raw
  // username the header never showed.
  // -------------------------------------------------------------------------
  it("prefers the display name over the raw username for both the title and the avatar initial", () => {
    const user = makeUser({
      username: "bob",
      displayName: "Charlie",
    });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const usernameEl = container.querySelector('[data-testid="dps-username"]');
    expect(usernameEl!.textContent).toBe("Charlie");

    const avatarEl = container.querySelector('[data-testid="dps-avatar"]');
    expect(avatarEl!.textContent).toBe("C");

    sidebar.destroy?.();
  });

  it("falls back to the username when no display name is set", () => {
    const user = makeUser({ username: "bob", displayName: null });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const usernameEl = container.querySelector('[data-testid="dps-username"]');
    expect(usernameEl!.textContent).toBe("bob");

    const avatarEl = container.querySelector('[data-testid="dps-avatar"]');
    expect(avatarEl!.textContent).toBe("B");

    sidebar.destroy?.();
  });

  // -------------------------------------------------------------------------
  // Test 2: Sidebar displays correct user profile data
  // -------------------------------------------------------------------------
  it("displays correct user profile data", () => {
    const user = makeUser({
      id: 42,
      username: "TestUser",
      status: "idle",
      about: "I like coding",
      joinDate: "Mar 15, 2024",
    });

    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    // Username
    const usernameEl = container.querySelector('[data-testid="dps-username"]');
    expect(usernameEl).not.toBeNull();
    expect(usernameEl!.textContent).toBe("TestUser");

    // Status
    const statusEl = container.querySelector('[data-testid="dps-status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toContain("Idle");

    // About section
    const aboutEl = container.querySelector('[data-testid="dps-about"]');
    expect(aboutEl).not.toBeNull();
    expect(aboutEl!.textContent).toBe("I like coding");

    // Join date
    const joinEl = container.querySelector('[data-testid="dps-join-date"]');
    expect(joinEl).not.toBeNull();
    expect(joinEl!.textContent).toBe("Mar 15, 2024");

    // Avatar shows initial when no avatar URL
    const avatarEl = container.querySelector('[data-testid="dps-avatar"]');
    expect(avatarEl).not.toBeNull();
    expect(avatarEl!.textContent).toContain("T");

    // Note field exists
    const noteEl = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
    expect(noteEl).not.toBeNull();

    // A11y attributes
    const panel = container.querySelector('[data-testid="dm-profile-sidebar"]');
    expect(panel!.getAttribute("role")).toBe("complementary");
    expect(panel!.getAttribute("aria-label")).toBe("User profile");

    sidebar.destroy?.();
  });

  it("shows avatar image when avatar URL is provided", async () => {
    // <img src> cannot carry the bearer token an authenticated file route
    // needs, so the picture is fetched and swapped in, never assigned raw.
    fetchImageAsDataUrl.mockResolvedValue("data:image/png;base64,AAA");
    const user = makeUser({ avatar: "https://example.com/avatar.png" });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    expect(fetchImageAsDataUrl).toHaveBeenCalledWith("https://example.com/avatar.png");
    await vi.waitFor(() => {
      const img = container.querySelector(".dps-avatar-img") as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.src).toBe("data:image/png;base64,AAA");
    });

    sidebar.destroy?.();
  });

  it("fetches a server-relative avatar through the authenticated path and draws the letter until it arrives", async () => {
    fetchImageAsDataUrl.mockResolvedValue("data:image/png;base64,BBB");
    const user = makeUser({ username: "Bob", avatar: "/api/v1/files/42" });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const avatarEl = container.querySelector('[data-testid="dps-avatar"]') as HTMLDivElement;
    expect(avatarEl.textContent).toContain("B");
    expect(avatarEl.querySelector("img")).toBeNull();

    await vi.waitFor(() => {
      expect(fetchImageAsDataUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/42");
      const img = avatarEl.querySelector(".dps-avatar-img");
      expect(img).not.toBeNull();
    });

    sidebar.destroy?.();
  });

  it("hides about section when about is null", () => {
    const user = makeUser({ about: null });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const aboutEl = container.querySelector('[data-testid="dps-about"]');
    expect(aboutEl).toBeNull();

    sidebar.destroy?.();
  });

  it("hides join date section when joinDate is null", () => {
    const user = makeUser({ joinDate: null });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const joinEl = container.querySelector('[data-testid="dps-join-date"]');
    expect(joinEl).toBeNull();

    sidebar.destroy?.();
  });

  it("persists note to localStorage", () => {
    const user = makeUser({ id: 99 });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const noteEl = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
    noteEl.value = "Test note content";
    noteEl.dispatchEvent(new Event("input"));

    expect(localStorage.getItem("owncord:dm-note:99")).toBe("Test note content");

    sidebar.destroy?.();

    // Remount and verify note is loaded
    const sidebar2 = createDmProfileSidebar(makeOptions({ user }));
    sidebar2.mount(container);

    const noteEl2 = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
    expect(noteEl2.value).toBe("Test note content");

    sidebar2.destroy?.();
    localStorage.removeItem("owncord:dm-note:99");
  });

  it("scopes the note to the server host when one is supplied", () => {
    // User ids are per-server, so an unscoped key means a note about user 5
    // on server A is shown for, and overwritten by, the unrelated user 5 on
    // server B in the multi-profile client.
    const user = makeUser({ id: 5 });
    const sidebarA = createDmProfileSidebar(makeOptions({ user, host: "a.example.com" }));
    sidebarA.mount(container);
    const noteElA = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
    noteElA.value = "Note about server A's user 5";
    noteElA.dispatchEvent(new Event("input"));
    sidebarA.destroy?.();

    expect(localStorage.getItem("owncord:dm-note:a.example.com:5")).toBe(
      "Note about server A's user 5",
    );

    // The unrelated user 5 on a different server sees no note.
    const sidebarB = createDmProfileSidebar(makeOptions({ user, host: "b.example.com" }));
    sidebarB.mount(container);
    const noteElB = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
    expect(noteElB.value).toBe("");
    sidebarB.destroy?.();

    localStorage.removeItem("owncord:dm-note:a.example.com:5");
  });

  // -------------------------------------------------------------------------
  // OC-0309: the panel has no store subscription of its own (by design --
  // it's presentational) and is only ever painted once at mount from an
  // open-time snapshot. update() is the mechanism its owner (MainPage) uses
  // to repaint it in place when the underlying user's status/name changes
  // while it stays open, so the panel doesn't disagree with the chat header
  // it was opened from indefinitely.
  // -------------------------------------------------------------------------
  it("repaints name, avatar initial and status (dot + label) in place via update()", () => {
    const user = makeUser({ id: 7, username: "bob", displayName: null, status: "online" });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    expect(container.querySelector('[data-testid="dps-username"]')!.textContent).toBe("bob");
    expect(container.querySelector('[data-testid="dps-status"]')!.textContent).toContain("Online");
    expect(container.querySelector('[data-testid="dps-avatar"]')!.textContent).toContain("B");

    sidebar.update({ ...user, displayName: "Bobby", status: "offline" });

    expect(container.querySelector('[data-testid="dps-username"]')!.textContent).toBe("Bobby");
    expect(container.querySelector('[data-testid="dps-status"]')!.textContent).toContain("Offline");
    expect(container.querySelector('[data-testid="dps-avatar"]')!.textContent).toContain("B");

    // Repainted in place -- the panel element itself was never rebuilt.
    expect(container.querySelectorAll('[data-testid="dm-profile-sidebar"]')).toHaveLength(1);

    sidebar.destroy?.();
  });

  it("does not throw and is a no-op when update() is called before mount or after destroy", () => {
    const user = makeUser({ id: 8 });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));

    expect(() => sidebar.update({ ...user, status: "dnd" })).not.toThrow();

    sidebar.mount(container);
    sidebar.destroy?.();

    expect(() => sidebar.update({ ...user, status: "idle" })).not.toThrow();
  });

  it("falls back to the legacy unscoped key to migrate a note saved before host-scoping", () => {
    const user = makeUser({ id: 42 });
    localStorage.setItem("owncord:dm-note:42", "Pre-existing note");

    const sidebar = createDmProfileSidebar(makeOptions({ user, host: "a.example.com" }));
    sidebar.mount(container);
    const noteEl = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;

    expect(noteEl.value).toBe("Pre-existing note");

    sidebar.destroy?.();
    // The migration wrote server A's scoped copy; clear both keys.
    localStorage.removeItem("owncord:dm-note:42");
    localStorage.removeItem("owncord:dm-note:a.example.com:42");
  });

  it("consumes the legacy note on migration so a second host does not inherit it (OC-0329)", () => {
    // User ids are per-server, so the pre-scoping note about server A's user
    // 42 must reach server A exactly once and never show for the unrelated
    // user 42 on server B.
    const user = makeUser({ id: 42 });
    localStorage.setItem("owncord:dm-note:42", "Pre-existing note");

    try {
      const sidebarA = createDmProfileSidebar(makeOptions({ user, host: "a.example.com" }));
      sidebarA.mount(container);
      const noteElA = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
      expect(noteElA.value).toBe("Pre-existing note");
      sidebarA.destroy?.();

      // Migrated under server A's key and consumed at the legacy one.
      expect(localStorage.getItem("owncord:dm-note:a.example.com:42")).toBe("Pre-existing note");
      expect(localStorage.getItem("owncord:dm-note:42")).toBeNull();

      const sidebarB = createDmProfileSidebar(makeOptions({ user, host: "b.example.com" }));
      sidebarB.mount(container);
      const noteElB = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
      expect(noteElB.value).toBe("");
      sidebarB.destroy?.();

      // Reopening server A still finds its migrated note.
      const sidebarA2 = createDmProfileSidebar(makeOptions({ user, host: "a.example.com" }));
      sidebarA2.mount(container);
      const noteElA2 = container.querySelector('[data-testid="dps-note"]') as HTMLTextAreaElement;
      expect(noteElA2.value).toBe("Pre-existing note");
      sidebarA2.destroy?.();
    } finally {
      localStorage.removeItem("owncord:dm-note:42");
      localStorage.removeItem("owncord:dm-note:a.example.com:42");
      localStorage.removeItem("owncord:dm-note:b.example.com:42");
    }
  });
});
