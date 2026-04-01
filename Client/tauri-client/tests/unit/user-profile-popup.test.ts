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

    popup.destroy();
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

    // Message and Call buttons
    const msgBtn = container.querySelector('[data-testid="upp-message-btn"]');
    expect(msgBtn).not.toBeNull();
    const callBtn = container.querySelector('[data-testid="upp-call-btn"]');
    expect(callBtn).not.toBeNull();

    popup.destroy();
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

    popup.destroy();
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
