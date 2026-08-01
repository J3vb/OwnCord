import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUserProfilePopup, type UserProfileData } from "@components/UserProfilePopup";

function makeUser(overrides?: Partial<UserProfileData>): UserProfileData {
  return {
    id: 42,
    username: "testuser",
    avatar: null,
    role: "member",
    status: "online",
    about: "Hello there!",
    joinDate: "2024-01-15",
    isDeleted: false,
    ...overrides,
  };
}

describe("UserProfilePopup", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("click trigger opens popup with correct content", () => {
    const user = makeUser({ username: "alice", role: "admin" });
    const popup = createUserProfilePopup({
      user,
      anchorX: 200,
      anchorY: 300,
    });
    popup.mount(container);

    const popupEl = container.querySelector('[data-testid="user-profile-popup"]');
    expect(popupEl).not.toBeNull();

    // Check username displayed
    const nameEl = container.querySelector(".upp-username");
    expect(nameEl?.textContent).toBe("alice");

    // Check role badge
    const roleBadge = container.querySelector(".upp-role-badge");
    expect(roleBadge?.textContent).toContain("Admin");

    // Check about section
    const about = container.querySelector(".upp-about-text");
    expect(about?.textContent).toBe("Hello there!");

    // Check dialog role
    expect(popupEl?.getAttribute("role")).toBe("dialog");
    expect(popupEl?.getAttribute("aria-label")).toBe("User profile");

    popup.destroy?.();
  });

  it("displays content correctly including status and join date", () => {
    const user = makeUser({
      username: "bob",
      status: "dnd",
      joinDate: "2023-06-01",
    });
    const popup = createUserProfilePopup({
      user,
      anchorX: 100,
      anchorY: 100,
      onMessage: () => {},
      onCall: () => {},
    });
    popup.mount(container);

    // Status label should show "Do Not Disturb"
    const statusLine = container.querySelector(".upp-status-line");
    expect(statusLine?.textContent).toContain("Do Not Disturb");

    // Join date
    const joinText = container.querySelector(".upp-join-text");
    expect(joinText?.textContent).toBe("2023-06-01");

    // Avatar initial for "bob" should be "B"
    const avatar = container.querySelector(".upp-avatar span");
    expect(avatar?.textContent).toBe("B");

    // Message and Call buttons render when handlers are wired
    const msgBtn = container.querySelector('[data-testid="upp-message-btn"]');
    expect(msgBtn).not.toBeNull();
    const callBtn = container.querySelector('[data-testid="upp-call-btn"]');
    expect(callBtn).not.toBeNull();

    popup.destroy?.();
  });

  it("omits action buttons that have no handler", () => {
    const popup = createUserProfilePopup({
      user: makeUser(),
      anchorX: 100,
      anchorY: 100,
    });
    popup.mount(container);

    expect(container.querySelector('[data-testid="upp-message-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="upp-call-btn"]')).toBeNull();

    popup.destroy?.();
  });

  it("outside click closes the popup", () => {
    const user = makeUser();
    const popup = createUserProfilePopup({
      user,
      anchorX: 200,
      anchorY: 200,
    });
    popup.mount(container);

    expect(popup.isOpen()).toBe(true);

    // Simulate a mousedown on the overlay (outside the popup)
    const overlay = container.querySelector('[data-testid="user-profile-overlay"]') as HTMLElement;
    expect(overlay).not.toBeNull();

    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 1,
      clientY: 1,
    });
    overlay.dispatchEvent(event);

    expect(popup.isOpen()).toBe(false);
    expect(container.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
  });

  it("handles deleted users with [deleted] name and gray avatar", () => {
    const user = makeUser({
      username: "removed",
      isDeleted: true,
    });
    const popup = createUserProfilePopup({
      user,
      anchorX: 100,
      anchorY: 100,
    });
    popup.mount(container);

    const nameEl = container.querySelector(".upp-username");
    expect(nameEl?.textContent).toBe("[deleted]");

    // Avatar should have gray background
    const avatar = container.querySelector(".upp-avatar") as HTMLElement;
    expect(avatar.style.background).toBe("rgb(78, 80, 88)"); // #4e5058

    popup.destroy?.();
  });

  it("Escape key closes the popup", () => {
    const user = makeUser();
    const popup = createUserProfilePopup({
      user,
      anchorX: 200,
      anchorY: 200,
    });
    popup.mount(container);

    expect(popup.isOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(popup.isOpen()).toBe(false);
  });
});

// ─── Phase 6: display name, about, custom status ─────────────────────────────

describe("UserProfilePopup profile fields", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the display name as the heading and the username as an @handle", () => {
    const popup = createUserProfilePopup({
      user: makeUser({ username: "alice", displayName: "Alice A." }),
      anchorX: 10,
      anchorY: 10,
    });
    popup.mount(container);

    expect(container.querySelector(".upp-username")?.textContent).toBe("Alice A.");
    // The username is still the handle you @mention, so the popup keeps
    // telling you what to type.
    expect(container.querySelector(".upp-username-handle")?.textContent).toBe("@alice");

    popup.destroy?.();
  });

  it("omits the @handle when there is no display name", () => {
    const popup = createUserProfilePopup({
      user: makeUser({ username: "alice", displayName: null }),
      anchorX: 10,
      anchorY: 10,
    });
    popup.mount(container);

    expect(container.querySelector(".upp-username")?.textContent).toBe("alice");
    expect(container.querySelector(".upp-username-handle")?.textContent).toBe("");

    popup.destroy?.();
  });

  it("renders the about section from real data", () => {
    const popup = createUserProfilePopup({
      user: makeUser({ about: "Writes tests for a living." }),
      anchorX: 10,
      anchorY: 10,
    });
    popup.mount(container);

    // The section used to be dead code — `about` was hardcoded null at every
    // call site until phase 6 gave the column somewhere to come from.
    expect(container.querySelector(".upp-about-text")?.textContent).toBe(
      "Writes tests for a living.",
    );

    popup.destroy?.();
  });

  it("renders the custom status line, and nothing when there is none", () => {
    const withStatus = createUserProfilePopup({
      user: makeUser({ customStatus: "shipping phase 6" }),
      anchorX: 10,
      anchorY: 10,
    });
    withStatus.mount(container);
    expect(container.querySelector(".upp-custom-status")?.textContent).toBe("shipping phase 6");
    withStatus.destroy?.();

    const without = createUserProfilePopup({ user: makeUser(), anchorX: 10, anchorY: 10 });
    without.mount(container);
    expect(container.querySelector(".upp-custom-status")?.textContent).toBe("");
    without.destroy?.();
  });

  it("labels the owner's own invisible status", () => {
    // Only ever reachable for the signed-in user: everyone else is mapped to
    // offline before the payload leaves the server.
    const popup = createUserProfilePopup({
      user: makeUser({ status: "invisible" }),
      anchorX: 10,
      anchorY: 10,
    });
    popup.mount(container);

    const statusText = container.querySelector(".upp-status-line")?.textContent ?? "";
    expect(statusText).toContain("Invisible");

    popup.destroy?.();
  });

  it("uses the display name's initial for the letter fallback", () => {
    const popup = createUserProfilePopup({
      user: makeUser({ username: "alice", displayName: "Zoe", avatar: null }),
      anchorX: 10,
      anchorY: 10,
    });
    popup.mount(container);

    expect(container.querySelector(".upp-avatar .avatar-initial")?.textContent).toBe("Z");

    popup.destroy?.();
  });
});
