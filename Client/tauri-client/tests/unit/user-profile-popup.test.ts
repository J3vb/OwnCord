import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("UserProfilePopup positioning", () => {
  let container: HTMLDivElement;
  let originalInnerWidth: number;
  let originalInnerHeight: number;
  let offsetHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;
  });

  afterEach(() => {
    container.remove();
    window.innerWidth = originalInnerWidth;
    window.innerHeight = originalInnerHeight;
    if (offsetHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      offsetHeightDescriptor = undefined;
    }
  });

  function getPopupEl(): HTMLElement {
    return container.querySelector('[data-testid="user-profile-popup"]') as HTMLElement;
  }

  it("places the card to the right of the anchor, offset by the gap, when it fits", () => {
    window.innerWidth = 800;
    window.innerHeight = 600;
    const popup = createUserProfilePopup({ user: makeUser(), anchorX: 100, anchorY: 100 });
    popup.mount(container);

    // 100 + 8 (gap) = 108, and 108 + 300 (width) = 408 fits inside 800 - 8, so
    // no flip. jsdom never lays anything out (offsetHeight is 0), so nothing
    // overflows the bottom either and top stays at the anchor.
    expect(getPopupEl().style.left).toBe("108px");
    expect(getPopupEl().style.top).toBe("100px");

    popup.destroy?.();
  });

  it("flips the card to the left of the anchor when there is no room on the right", () => {
    window.innerWidth = 1024;
    window.innerHeight = 768;
    const popup = createUserProfilePopup({ user: makeUser(), anchorX: 1020, anchorY: 100 });
    popup.mount(container);

    // 1020 + 8 + 300 = 1328 overflows the 1016px right bound, so it flips to
    // sit left of the anchor instead: 1020 - 300 - 8 = 712.
    expect(getPopupEl().style.left).toBe("712px");

    popup.destroy?.();
  });

  it("clamps the left edge to the viewport margin when even the flipped position runs off both edges", () => {
    window.innerWidth = 200;
    window.innerHeight = 600;
    const popup = createUserProfilePopup({ user: makeUser(), anchorX: 50, anchorY: 100 });
    popup.mount(container);

    // The 300px-wide card can't fit on either side of a 200px-wide window, so
    // the flip still overflows negative and gets clamped to the margin.
    expect(getPopupEl().style.left).toBe("8px");

    popup.destroy?.();
  });

  it("lifts the card above the anchor so it fits when it would run off the bottom of the window", () => {
    window.innerWidth = 1024;
    window.innerHeight = 500;
    // jsdom never lays anything out, so offsetHeight is always 0. Stub the
    // popup card's measured height so the overflow branch actually triggers.
    offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "user-profile-popup" ? 400 : 0;
      },
    });
    const popup = createUserProfilePopup({ user: makeUser(), anchorX: 10, anchorY: 450 });
    popup.mount(container);

    // 450 + 400 (measured height) = 850 overflows the 492px bottom bound, so
    // the card is lifted to 500 - 400 - 8 = 92.
    expect(getPopupEl().style.top).toBe("92px");

    popup.destroy?.();
  });

  it("clamps the top edge to the viewport margin when the anchor is near the top edge", () => {
    window.innerWidth = 1024;
    window.innerHeight = 768;
    const popup = createUserProfilePopup({ user: makeUser(), anchorX: 10, anchorY: 2 });
    popup.mount(container);

    expect(getPopupEl().style.top).toBe("8px");

    popup.destroy?.();
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
