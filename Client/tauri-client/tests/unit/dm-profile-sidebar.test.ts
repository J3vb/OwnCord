import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("shows avatar image when avatar URL is provided", () => {
    const user = makeUser({ avatar: "https://example.com/avatar.png" });
    const sidebar = createDmProfileSidebar(makeOptions({ user }));
    sidebar.mount(container);

    const img = container.querySelector(".dps-avatar-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("https://example.com/avatar.png");

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
});
