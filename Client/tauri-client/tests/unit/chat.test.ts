/**
 * Step 5.47 — Chat unit tests.
 * Tests for message grouping, day dividers, @mention parsing,
 * typing indicator, reaction bar, message actions, and message input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// MessageList helpers (we test the exported component's behavior via DOM)
// ---------------------------------------------------------------------------

import { createMessageList } from "../../src/components/MessageList";
import {
  messagesStore,
  addMessage,
  setMessages,
} from "../../src/stores/messages.store";
import { membersStore, setMembers } from "../../src/stores/members.store";

// Reset stores before each test
function resetStores(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

// Helper to create a basic message payload
function makeMessage(
  id: number,
  userId: number,
  username: string,
  content: string,
  timestamp: string,
  opts?: {
    replyTo?: number;
    deleted?: boolean;
    editedAt?: string;
    role?: string;
  },
) {
  return {
    id,
    channel_id: 1,
    user: {
      id: userId,
      username,
      avatar: null,
      role: opts?.role ?? "member",
    },
    content,
    reply_to: opts?.replyTo ?? null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: opts?.editedAt ?? null,
    deleted: opts?.deleted ?? false,
    timestamp,
  };
}

describe("MessageList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders empty when no messages", () => {
    const list = createMessageList({
      channelId: 1,
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
    });
    list.mount(container);
    const messagesContainer = container.querySelector(".messages-container");
    expect(messagesContainer).not.toBeNull();
    const virtualContent = messagesContainer?.querySelector(".virtual-content");
    expect(virtualContent).not.toBeNull();
    expect(virtualContent?.children.length).toBe(0);
    list.destroy?.();
  });

  it("renders messages after store update", () => {
    setMessages(1, [
      makeMessage(1, 10, "Alice", "Hello", "2026-03-15T10:00:00Z"),
    ], false);

    const list = createMessageList({
      channelId: 1,
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
    });
    list.mount(container);

    const groups = container.querySelectorAll(".message");
    expect(groups.length).toBe(1);
    const username = container.querySelector(".msg-author");
    expect(username?.textContent).toBe("Alice");
    list.destroy?.();
  });

  describe("message grouping", () => {
    it("groups consecutive messages from same user within 5 minutes", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "Hi", "2026-03-15T10:00:00Z"),
        makeMessage(2, 10, "Alice", "How are you?", "2026-03-15T10:02:00Z"),
        makeMessage(3, 10, "Alice", "Anyone there?", "2026-03-15T10:04:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const messages = container.querySelectorAll(".message");
      expect(messages.length).toBe(3);
      // 2nd and 3rd should be grouped
      expect(messages[1]?.classList.contains("grouped")).toBe(true);
      expect(messages[2]?.classList.contains("grouped")).toBe(true);
      list.destroy?.();
    });

    it("breaks group when user changes", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "Hi", "2026-03-15T10:00:00Z"),
        makeMessage(2, 20, "Bob", "Hey!", "2026-03-15T10:01:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const groups = container.querySelectorAll(".message");
      expect(groups.length).toBe(2);
      list.destroy?.();
    });

    it("breaks group when gap exceeds 5 minutes", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "Hi", "2026-03-15T10:00:00Z"),
        makeMessage(2, 10, "Alice", "Later", "2026-03-15T10:10:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const groups = container.querySelectorAll(".message");
      expect(groups.length).toBe(2);
      list.destroy?.();
    });
  });

  describe("day dividers", () => {
    it("inserts day divider between messages on different days", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "Day 1", "2026-03-10T12:00:00Z"),
        makeMessage(2, 10, "Alice", "Day 2", "2026-03-15T12:00:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const dividers = container.querySelectorAll(".msg-day-divider");
      expect(dividers.length).toBe(2); // one for each day
      list.destroy?.();
    });
  });

  describe("@mention parsing", () => {
    it("wraps @username in .mention span", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "Hey @Bob check this", "2026-03-15T10:00:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const mentions = container.querySelectorAll(".mention");
      expect(mentions.length).toBe(1);
      expect(mentions[0]?.textContent).toBe("@Bob");
      list.destroy?.();
    });

    it("handles multiple @mentions in one message", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "@Bob and @Charlie look", "2026-03-15T10:00:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const mentions = container.querySelectorAll(".mention");
      expect(mentions.length).toBe(2);
      list.destroy?.();
    });
  });

  describe("deleted and edited messages", () => {
    it("shows [message deleted] for deleted messages", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "secret", "2026-03-15T10:00:00Z", { deleted: true }),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const deleted = container.querySelector(".msg-text");
      expect(deleted?.textContent).toBe("[message deleted]");
      list.destroy?.();
    });

    it("shows (edited) indicator for edited messages", () => {
      setMessages(1, [
        makeMessage(1, 10, "Alice", "updated text", "2026-03-15T10:00:00Z", {
          editedAt: "2026-03-15T10:05:00Z",
        }),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const edited = container.querySelector(".msg-edited");
      expect(edited?.textContent).toBe("(edited)");
      list.destroy?.();
    });
  });

  describe("system messages", () => {
    it("applies msg--system class to System user messages", () => {
      setMessages(1, [
        makeMessage(1, 0, "System", "Alice joined", "2026-03-15T10:00:00Z"),
      ], false);

      const list = createMessageList({
        channelId: 1,
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
      });
      list.mount(container);

      const systemGroup = container.querySelector(".system-msg");
      expect(systemGroup).not.toBeNull();
      list.destroy?.();
    });
  });

  it("reacts to store changes", () => {
    const list = createMessageList({
      channelId: 1,
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
    });
    list.mount(container);

    expect(container.querySelectorAll(".message").length).toBe(0);

    // Add a message via store
    addMessage({
      id: 1,
      channel_id: 1,
      user: { id: 10, username: "Alice", avatar: null },
      content: "Hello!",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    messagesStore.flush();

    expect(container.querySelectorAll(".message").length).toBe(1);
    list.destroy?.();
  });

  it("cleans up subscriptions on destroy", () => {
    const list = createMessageList({
      channelId: 1,
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
    });
    list.mount(container);
    list.destroy?.();

    // After destroy, adding messages should not cause re-render
    addMessage({
      id: 2,
      channel_id: 1,
      user: { id: 10, username: "Alice", avatar: null },
      content: "After destroy",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    // Container should be empty since component was destroyed
    expect(container.querySelector(".messages-container")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TypingIndicator
// ---------------------------------------------------------------------------

import { createTypingIndicator } from "../../src/components/TypingIndicator";
import { setTyping, clearTyping } from "../../src/stores/members.store";

describe("TypingIndicator", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    setMembers([
      { id: 1, username: "Alice", avatar: null, role: "member", status: "online" },
      { id: 2, username: "Bob", avatar: null, role: "member", status: "online" },
      { id: 3, username: "Charlie", avatar: null, role: "member", status: "online" },
      { id: 10, username: "Me", avatar: null, role: "member", status: "online" },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("is hidden when no one is typing", () => {
    const indicator = createTypingIndicator({ channelId: 1, currentUserId: 10 });
    indicator.mount(container);

    const root = container.querySelector(".typing-bar");
    // Empty = hidden via CSS .typing-bar:empty { height: 0 }
    expect(root?.children.length).toBe(0);
    indicator.destroy?.();
  });

  it("shows single user typing", () => {
    const indicator = createTypingIndicator({ channelId: 1, currentUserId: 10 });
    indicator.mount(container);

    setTyping(1, 1); // Alice typing in channel 1
    membersStore.flush();

    const root = container.querySelector(".typing-bar");
    expect(root?.textContent).toContain("Alice");
    expect(root?.textContent).toContain("is typing");
    indicator.destroy?.();
  });

  it("shows two users typing", () => {
    const indicator = createTypingIndicator({ channelId: 1, currentUserId: 10 });
    indicator.mount(container);

    setTyping(1, 1); // Alice
    setTyping(1, 2); // Bob
    membersStore.flush();

    const root = container.querySelector(".typing-bar");
    expect(root?.textContent).toContain("and");
    expect(root?.textContent).toContain("are typing");
    indicator.destroy?.();
  });

  it("shows 'Several people' for 3+ users", () => {
    const indicator = createTypingIndicator({ channelId: 1, currentUserId: 10 });
    indicator.mount(container);

    setTyping(1, 1);
    setTyping(1, 2);
    setTyping(1, 3);
    membersStore.flush();

    const root = container.querySelector(".typing-bar");
    expect(root?.textContent).toContain("Several people are typing...");
    indicator.destroy?.();
  });

  it("excludes current user from typing display", () => {
    const indicator = createTypingIndicator({ channelId: 1, currentUserId: 10 });
    indicator.mount(container);

    setTyping(1, 10); // Me typing — should be filtered

    const root = container.querySelector(".typing-bar");
    expect(root?.children.length).toBe(0);
    indicator.destroy?.();
  });
});

// ---------------------------------------------------------------------------
// MessageInput
// ---------------------------------------------------------------------------

import { createMessageInput } from "../../src/components/MessageInput";

describe("MessageInput", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("mounts with textarea and send button", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    expect(container.querySelector(".msg-textarea")).not.toBeNull();
    expect(container.querySelector("[aria-label='Send message']")).not.toBeNull();
    input.destroy?.();
  });

  it("sends message on Enter key", () => {
    const onSend = vi.fn();
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello world";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onSend).toHaveBeenCalledWith("Hello world", null);
    input.destroy?.();
  });

  it("does not send on Shift+Enter", () => {
    const onSend = vi.fn();
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(onSend).not.toHaveBeenCalled();
    input.destroy?.();
  });

  it("clears input after sending", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(textarea.value).toBe("");
    input.destroy?.();
  });

  it("shows reply bar when setReplyTo is called", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    input.setReplyTo(5, "Alice");
    const replyBar = container.querySelector(".reply-bar");
    expect(replyBar?.classList.contains("visible")).toBe(true);
    expect(replyBar?.textContent).toContain("Alice");
    input.destroy?.();
  });

  it("hides reply bar when clearReply is called", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    input.setReplyTo(5, "Alice");
    input.clearReply();
    const replyBar = container.querySelector(".reply-bar");
    expect(replyBar?.classList.contains("visible")).toBe(false);
    input.destroy?.();
  });

  it("enters edit mode and calls onEditMessage", () => {
    const onEditMessage = vi.fn();
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage,
    });
    input.mount(container);

    input.startEdit(42, "original text");
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("original text");

    textarea.value = "updated text";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onEditMessage).toHaveBeenCalledWith(42, "updated text");
    input.destroy?.();
  });

  it("throttles typing events to 3 seconds", () => {
    vi.useFakeTimers();
    const onTyping = vi.fn();
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping,
      onEditMessage: vi.fn(),
    });
    input.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;

    // First input triggers typing
    textarea.dispatchEvent(new Event("input"));
    expect(onTyping).toHaveBeenCalledTimes(1);

    // Immediate second input should NOT trigger
    textarea.dispatchEvent(new Event("input"));
    expect(onTyping).toHaveBeenCalledTimes(1);

    // After 3 seconds, should trigger again
    vi.advanceTimersByTime(3000);
    textarea.dispatchEvent(new Event("input"));
    expect(onTyping).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    input.destroy?.();
  });
});
