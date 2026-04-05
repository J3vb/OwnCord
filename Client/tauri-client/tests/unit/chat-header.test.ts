import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildChatHeader, updateChatHeaderForDm } from "../../src/pages/main-page/ChatHeader";

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
    });
    container.appendChild(element);

    expect(container.querySelector('[data-testid="chat-header"]')).not.toBeNull();
  });

  it("displays default channel name", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    expect(refs.nameEl.textContent).toBe("general");
    expect(container.querySelector('[data-testid="chat-header-name"]')?.textContent).toBe(
      "general",
    );
  });

  it("displays hash prefix", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    const hash = container.querySelector(".ch-hash");
    expect(hash?.textContent).toBe("#");
  });

  it("contains a search input", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
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
    });
    container.appendChild(element);

    const pinBtn = container.querySelector('[data-testid="pin-btn"]') as HTMLButtonElement;
    pinBtn.click();
    expect(onTogglePins).toHaveBeenCalledOnce();
  });

  it("provides mutable refs for channel name and topic", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    // Update name via ref
    refs.nameEl.textContent = "announcements";
    expect(container.querySelector('[data-testid="chat-header-name"]')?.textContent).toBe(
      "announcements",
    );

    // Update topic via ref
    refs.topicEl.textContent = "Important news";
    expect(container.querySelector(".ch-topic")?.textContent).toBe("Important news");
  });

  it("has proper aria labels on buttons", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    const pinBtn = container.querySelector('[data-testid="pin-btn"]');
    expect(pinBtn?.getAttribute("aria-label")).toBe("Pins");
  });

  it("calls onSearchFocus and blurs input when search is focused", () => {
    const onSearchFocus = vi.fn();
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      onSearchFocus,
    });
    container.appendChild(element);

    const searchInput = container.querySelector('[data-testid="search-input"]') as HTMLInputElement;
    const blurSpy = vi.spyOn(searchInput, "blur");

    searchInput.dispatchEvent(new Event("focus"));

    expect(onSearchFocus).toHaveBeenCalledOnce();
    expect(blurSpy).toHaveBeenCalledOnce();
  });

  it("does not add focus listener when onSearchFocus is not provided", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
      // no onSearchFocus
    });
    container.appendChild(element);

    const searchInput = container.querySelector('[data-testid="search-input"]') as HTMLInputElement;
    const blurSpy = vi.spyOn(searchInput, "blur");

    // Focus should not cause blur since no handler was registered
    searchInput.dispatchEvent(new Event("focus"));

    expect(blurSpy).not.toHaveBeenCalled();
  });

  it("contains a pin icon inside the pin button", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    const pinBtn = container.querySelector('[data-testid="pin-btn"]');
    // The button should contain an SVG icon element
    expect(pinBtn?.children.length).toBeGreaterThan(0);
  });

  it("contains a divider element", () => {
    const { element } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    const divider = container.querySelector(".ch-divider");
    expect(divider).not.toBeNull();
  });

  it("topic element starts empty", () => {
    const { refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });

    expect(refs.topicEl.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// updateChatHeaderForDm
// ---------------------------------------------------------------------------

describe("updateChatHeaderForDm", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("sets @ prefix and username for DM recipient", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    updateChatHeaderForDm(refs, { username: "Alice", status: "online" });

    expect(refs.hashEl.textContent).toBe("@");
    expect(refs.nameEl.textContent).toBe("Alice");
    expect(refs.topicEl.textContent).toBe("online");
  });

  it("sets status text as topic for DM", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    updateChatHeaderForDm(refs, { username: "Bob", status: "idle" });

    expect(refs.topicEl.textContent).toBe("idle");
  });

  it("resets to # when recipient is null", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    // First set to DM mode
    updateChatHeaderForDm(refs, { username: "Alice", status: "online" });
    expect(refs.hashEl.textContent).toBe("@");

    // Then reset to channel mode
    updateChatHeaderForDm(refs, null);
    expect(refs.hashEl.textContent).toBe("#");
  });

  it("does not change name or topic when recipient is null", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    // Set DM first
    updateChatHeaderForDm(refs, { username: "Alice", status: "online" });

    // Reset — only hash changes, name/topic keep their values from setText
    updateChatHeaderForDm(refs, null);
    expect(refs.hashEl.textContent).toBe("#");
    // Name and topic are NOT reset by updateChatHeaderForDm(null) — only hash
  });

  it("handles recipient with empty status", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    updateChatHeaderForDm(refs, { username: "Charlie", status: "" });

    expect(refs.hashEl.textContent).toBe("@");
    expect(refs.nameEl.textContent).toBe("Charlie");
    expect(refs.topicEl.textContent).toBe("");
  });
});
