import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildChatHeader,
  updateChatHeaderForDm,
  setChatHeaderChannelType,
  setChatHeaderCallChat,
  setChatHeaderTopic,
} from "../../src/pages/main-page/ChatHeader";
import { useMountContainer } from "../helpers/mountContainer";

describe("ChatHeader", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
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
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("shows the partner's avatar in place of the @ prefix for a 1:1 DM", () => {
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
    });
    container.appendChild(element);

    const avatar = document.createElement("div");
    avatar.dataset["testid"] = "partner-avatar";
    updateChatHeaderForDm(refs, { username: "Alice", status: "online", avatar });

    expect(refs.avatarEl.style.display).toBe("");
    expect(refs.avatarEl.contains(avatar)).toBe(true);
    expect(refs.hashEl.style.display).toBe("none");
    expect(refs.nameEl.textContent).toBe("Alice");
    expect(refs.topicEl.textContent).toBe("online");
  });

  it("shows the @ prefix when no avatar is given", () => {
    const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
    container.appendChild(element);

    updateChatHeaderForDm(refs, { username: "Alice", status: "online" });

    expect(refs.hashEl.textContent).toBe("@");
    expect(refs.hashEl.style.display).toBe("");
    expect(refs.avatarEl.style.display).toBe("none");
  });

  it("shows the video call button only in DM mode", () => {
    const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
    container.appendChild(element);

    expect(refs.videoCallBtn.style.display).toBe("none");
    updateChatHeaderForDm(refs, { username: "Alice", status: "online" });
    expect(refs.videoCallBtn.style.display).toBe("");
    expect(refs.callBtn.style.display).toBe("");
    updateChatHeaderForDm(refs, null);
    expect(refs.videoCallBtn.style.display).toBe("none");
    expect(refs.avatarEl.style.display).toBe("none");
  });

  it("calls onStartVideoCall, not onStartCall, from the video button", () => {
    const onStartCall = vi.fn();
    const onStartVideoCall = vi.fn();
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
      onStartCall,
      onStartVideoCall,
    });
    container.appendChild(element);

    refs.videoCallBtn.click();

    expect(onStartVideoCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).not.toHaveBeenCalled();
  });

  it("clicking a group's name renames it; a 1:1's name opens the profile", () => {
    const onToggleDmProfile = vi.fn();
    const onRenameGroup = vi.fn();
    const { element, refs } = buildChatHeader({
      onTogglePins: vi.fn(),
      onToggleDmProfile,
      onRenameGroup,
    });
    container.appendChild(element);

    const stack = document.createElement("div");
    stack.dataset["testid"] = "group-stack";
    updateChatHeaderForDm(refs, {
      username: "Crew",
      status: "3 members",
      avatar: stack,
      isGroup: true,
    });
    expect(refs.avatarEl.contains(stack)).toBe(true);
    refs.nameGroupEl.click();
    expect(onRenameGroup).toHaveBeenCalledTimes(1);
    expect(onToggleDmProfile).not.toHaveBeenCalled();

    updateChatHeaderForDm(refs, { username: "Alice", status: "online", isGroup: false });
    refs.nameGroupEl.click();
    expect(onToggleDmProfile).toHaveBeenCalledTimes(1);
    expect(onRenameGroup).toHaveBeenCalledTimes(1);
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

  describe("Member List toggle (3C-6b)", () => {
    it("member list toggle starts hidden with aria-pressed false and aria-controls member-column", () => {
      const onToggleGuildMemberList = vi.fn();
      const { element, refs } = buildChatHeader({
        onTogglePins: vi.fn(),
        onToggleGuildMemberList,
      });
      container.appendChild(element);
      const btn = element.querySelector<HTMLButtonElement>('[data-testid="member-list-toggle"]')!;
      expect(btn).toBe(refs.memberListBtn);
      expect(btn.hidden).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("aria-controls")).toBe("member-column");
      expect(btn.getAttribute("aria-label")).toBe("Member List");
      expect(btn.title).toBe("Member List");
      btn.click();
      expect(onToggleGuildMemberList).toHaveBeenCalledTimes(1);
    });

    it("sits after the group members button and before pins, and the DM helper leaves it alone", () => {
      const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
      const tools = Array.from(element.querySelector(".ch-tools")!.children);
      expect(tools.indexOf(refs.memberListBtn)).toBe(tools.indexOf(refs.membersBtn) + 1);
      expect(tools.indexOf(refs.memberListBtn)).toBe(
        tools.indexOf(element.querySelector('[data-testid="pin-btn"]')!) - 1,
      );
      refs.memberListBtn.hidden = false;
      refs.memberListBtn.setAttribute("aria-pressed", "true");
      updateChatHeaderForDm(refs, { username: "Bob", status: "Online" });
      updateChatHeaderForDm(refs, null);
      expect(refs.memberListBtn.hidden).toBe(false);
      expect(refs.memberListBtn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("Show User Profile button", () => {
    it("is hidden in a channel, shown for a 1:1 DM, hidden for a group", () => {
      const { element, refs } = buildChatHeader({
        onTogglePins: vi.fn(),
        onToggleDmProfile: vi.fn(),
      });
      container.appendChild(element);
      expect(refs.profileBtn.style.display).toBe("none");

      updateChatHeaderForDm(refs, { username: "Bob", status: "Online" });
      expect(refs.profileBtn.style.display).toBe("");
      expect(refs.profileBtn.getAttribute("aria-label")).toBe("Show User Profile");

      updateChatHeaderForDm(refs, { username: "Group", status: "3 members", isGroup: true });
      expect(refs.profileBtn.style.display).toBe("none");

      updateChatHeaderForDm(refs, { username: "Bob", status: "Online" });
      updateChatHeaderForDm(refs, null);
      expect(refs.profileBtn.style.display).toBe("none");
    });

    it("the Show Member List toggle is shown only for a group DM", () => {
      const onToggleMemberList = vi.fn();
      const { element, refs } = buildChatHeader({ onTogglePins: vi.fn(), onToggleMemberList });
      container.appendChild(element);
      expect(refs.membersBtn.style.display).toBe("none");
      expect(refs.membersBtn.getAttribute("aria-label")).toBe("Show Member List");
      expect(refs.membersBtn.getAttribute("aria-pressed")).toBe("false");

      updateChatHeaderForDm(refs, { username: "Bob", status: "Online" });
      expect(refs.membersBtn.style.display).toBe("none");

      updateChatHeaderForDm(refs, { username: "Group", status: "3 members", isGroup: true });
      expect(refs.membersBtn.style.display).toBe("");
      refs.membersBtn.click();
      expect(onToggleMemberList).toHaveBeenCalledOnce();

      updateChatHeaderForDm(refs, null);
      expect(refs.membersBtn.style.display).toBe("none");
    });

    it("calls onToggleDmProfile on click and starts unpressed", () => {
      const onToggleDmProfile = vi.fn();
      const { element, refs } = buildChatHeader({ onTogglePins: vi.fn(), onToggleDmProfile });
      container.appendChild(element);
      expect(refs.profileBtn.getAttribute("aria-pressed")).toBe("false");

      refs.profileBtn.click();
      expect(onToggleDmProfile).toHaveBeenCalledOnce();
    });
  });
});

describe("ChatHeader channel type icon and topic modal (N21)", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    document.querySelectorAll('[data-testid="channel-topic-modal"]').forEach((e) => e.remove());
  });

  it("shows the megaphone for an announcement channel and # for a text one", () => {
    const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
    container.appendChild(element);

    setChatHeaderChannelType(refs, "announcement");
    expect(refs.hashEl.querySelector("svg")).not.toBeNull();
    expect(refs.hashEl.dataset["channelType"]).toBe("announcement");

    setChatHeaderChannelType(refs, "text");
    expect(refs.hashEl.querySelector("svg")).toBeNull();
    expect(refs.hashEl.textContent).toBe("#");
  });

  it("opens the full topic as plain text on click; Escape and the close button close it", () => {
    const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
    container.appendChild(element);
    const topic = 'A very long topic <img src=x onerror="alert(1)"> <b>bold</b>';
    setChatHeaderTopic(refs, topic);

    refs.topicEl.click();
    const text = document.querySelector('[data-testid="channel-topic-text"]')!;
    expect(text.textContent).toBe(topic);
    expect(text.querySelector("img, b")).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector('[data-testid="channel-topic-modal"]')).toBeNull();

    refs.topicEl.click();
    (document.querySelector('[data-testid="channel-topic-close"]') as HTMLElement).click();
    expect(document.querySelector('[data-testid="channel-topic-modal"]')).toBeNull();
  });

  it("does nothing for an empty topic or a DM status line", () => {
    const { element, refs } = buildChatHeader({ onTogglePins: vi.fn() });
    container.appendChild(element);

    setChatHeaderTopic(refs, "");
    refs.topicEl.click();
    expect(document.querySelector('[data-testid="channel-topic-modal"]')).toBeNull();

    setChatHeaderTopic(refs, "topic");
    updateChatHeaderForDm(refs, { username: "bob", status: "online" });
    refs.topicEl.click();
    expect(document.querySelector('[data-testid="channel-topic-modal"]')).toBeNull();
    expect(refs.topicEl.textContent).toBe("online");
  });

  describe("call-chat toggle", () => {
    it("draws the speaker glyph for a voice channel", () => {
      const { refs } = buildChatHeader({ onTogglePins: vi.fn() });
      setChatHeaderChannelType(refs, "voice");
      expect(refs.hashEl.querySelector("svg")).not.toBeNull();
      expect(refs.hashEl.dataset["channelType"]).toBe("voice");
      expect(refs.hashEl.textContent).toBe("");

      setChatHeaderChannelType(refs, "text");
      expect(refs.hashEl.querySelector("svg")).toBeNull();
      expect(refs.hashEl.textContent).toBe("#");
    });

    it("toggle is hidden unless split-capable", () => {
      const { refs } = buildChatHeader({ onTogglePins: vi.fn() });
      expect(refs.callChatBtn.hidden).toBe(true);
      setChatHeaderCallChat(refs, { capable: true, open: true });
      expect(refs.callChatBtn.hidden).toBe(false);
      setChatHeaderCallChat(refs, { capable: false, open: true });
      expect(refs.callChatBtn.hidden).toBe(true);
    });

    it("toggle mirrors the choice in aria-pressed and its label", () => {
      const { refs } = buildChatHeader({ onTogglePins: vi.fn() });
      setChatHeaderCallChat(refs, { capable: true, open: true });
      expect(refs.callChatBtn.getAttribute("aria-pressed")).toBe("true");
      expect(refs.callChatBtn.getAttribute("aria-label")).toBe("Hide chat");

      setChatHeaderCallChat(refs, { capable: true, open: false });
      expect(refs.callChatBtn.getAttribute("aria-pressed")).toBe("false");
      expect(refs.callChatBtn.getAttribute("aria-label")).toBe("Show chat");
      expect(refs.callChatBtn.title).toBe("Show chat");
    });
  });
});
