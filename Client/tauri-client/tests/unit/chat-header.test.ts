import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildChatHeader } from "../../src/pages/main-page/ChatHeader";

describe("ChatHeader", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the chat header element", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    expect(container.querySelector('[data-testid="chat-header"]')).not.toBeNull();
  });

  it("displays default channel name", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    expect(refs.nameEl.textContent).toBe("general");
    expect(container.querySelector('[data-testid="chat-header-name"]')?.textContent).toBe("general");
  });

  it("displays hash prefix", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    const hash = container.querySelector(".ch-hash");
    expect(hash?.textContent).toBe("#");
  });

  it("contains a search input", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    const searchInput = container.querySelector(".search-input") as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    expect(searchInput.placeholder).toBe("Search...");
  });

  it("calls onTogglePins when pin button is clicked", () => {
    const onTogglePins = vi.fn();
    const { element } = buildChatHeader({
      onTogglePins,
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    const pinBtn = container.querySelector('[data-testid="pin-btn"]') as HTMLButtonElement;
    pinBtn.click();
    expect(onTogglePins).toHaveBeenCalledOnce();
  });

  it("calls onToggleMembers when members toggle is clicked", () => {
    const onToggleMembers = vi.fn();
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers,
    });
    container.appendChild(element);

    const membersToggle = container.querySelector('[data-testid="members-toggle"]') as HTMLButtonElement;
    membersToggle.click();
    expect(onToggleMembers).toHaveBeenCalledOnce();
  });

  it("provides mutable refs for channel name and topic", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    // Update name via ref
    refs.nameEl.textContent = "announcements";
    expect(container.querySelector('[data-testid="chat-header-name"]')?.textContent).toBe("announcements");

    // Update topic via ref
    refs.topicEl.textContent = "Important news";
    expect(container.querySelector(".ch-topic")?.textContent).toBe("Important news");
  });

  it("has proper aria labels on buttons", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleMembers: vi.fn(),
    });
    container.appendChild(element);

    const pinBtn = container.querySelector('[data-testid="pin-btn"]');
    expect(pinBtn?.getAttribute("aria-label")).toBe("Pins");

    const membersToggle = container.querySelector('[data-testid="members-toggle"]');
    expect(membersToggle?.getAttribute("aria-label")).toBe("Toggle member list");
  });
});
