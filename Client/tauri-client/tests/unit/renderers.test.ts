import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTime,
  formatFullDate,
  isSameDay,
  shouldGroup,
  renderDayDivider,
  renderMessage,
  renderMentions,
  GROUP_THRESHOLD_MS,
} from "../../src/components/message-list/renderers";
import type { Message } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import type { MessageListOptions } from "../../src/components/MessageList";

function resetStores(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    channelId: 1,
    user: { id: 10, username: "Alice", avatar: null },
    content: "Hello world",
    replyTo: null,
    attachments: [],
    reactions: [],
    editedAt: null,
    deleted: false,
    timestamp: "2025-01-15T12:30:00Z",
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
  return {
    channelId: 1,
    currentUserId: 10,
    onScrollTop: vi.fn(),
    onReplyClick: vi.fn(),
    onEditClick: vi.fn(),
    onDeleteClick: vi.fn(),
    onReactionClick: vi.fn(),
    ...overrides,
  };
}

describe("renderers", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe("formatTime", () => {
    it("formats ISO timestamp to HH:MM", () => {
      const result = formatTime("2025-01-15T09:05:00Z");
      // Result depends on timezone but should be formatted as HH:MM
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });
  });

  describe("formatFullDate", () => {
    it("formats ISO timestamp to full date string", () => {
      const result = formatFullDate("2025-01-15T12:00:00Z");
      expect(result).toContain("2025");
      expect(result).toContain("January");
    });
  });

  describe("isSameDay", () => {
    it("returns true for timestamps on the same day", () => {
      expect(isSameDay("2025-01-15T08:00:00Z", "2025-01-15T20:00:00Z")).toBe(true);
    });

    it("returns false for timestamps on different days", () => {
      expect(isSameDay("2025-01-15T08:00:00Z", "2025-01-16T08:00:00Z")).toBe(false);
    });
  });

  describe("shouldGroup", () => {
    it("returns true for same user within threshold", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({ id: 2, timestamp: "2025-01-15T12:04:00Z" });
      expect(shouldGroup(prev, curr)).toBe(true);
    });

    it("returns false for different users", () => {
      const prev = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const curr = makeMessage({
        id: 2,
        user: { id: 20, username: "Bob", avatar: null },
        timestamp: "2025-01-15T12:31:00Z",
      });
      expect(shouldGroup(prev, curr)).toBe(false);
    });

    it("returns false when time difference exceeds threshold", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({
        id: 2,
        timestamp: "2025-01-15T12:06:00Z",
      });
      expect(shouldGroup(prev, curr)).toBe(false);
    });

    it("returns false when either message is deleted", () => {
      const prev = makeMessage({ deleted: true });
      const curr = makeMessage({ id: 2, timestamp: "2025-01-15T12:31:00Z" });
      expect(shouldGroup(prev, curr)).toBe(false);
    });
  });

  describe("renderDayDivider", () => {
    it("creates a day divider element with formatted date", () => {
      const divider = renderDayDivider("2025-01-15T12:00:00Z");
      container.appendChild(divider);

      expect(divider.classList.contains("msg-day-divider")).toBe(true);
      const dateEl = divider.querySelector(".date");
      expect(dateEl).not.toBeNull();
      expect(dateEl!.textContent).toContain("January");
      expect(dateEl!.textContent).toContain("2025");
    });

    it("includes line elements", () => {
      const divider = renderDayDivider("2025-01-15T12:00:00Z");
      const lines = divider.querySelectorAll(".line");
      expect(lines.length).toBe(2);
    });
  });

  describe("renderMentions", () => {
    it("wraps @mentions in span with mention class", () => {
      const fragment = renderMentions("Hello @alice how are you?");
      container.appendChild(fragment);

      const mention = container.querySelector(".mention");
      expect(mention).not.toBeNull();
      expect(mention!.textContent).toBe("@alice");
    });

    it("renders plain text without mentions", () => {
      const fragment = renderMentions("Hello world");
      container.appendChild(fragment);

      expect(container.querySelector(".mention")).toBeNull();
      expect(container.textContent).toBe("Hello world");
    });

    it("handles multiple mentions", () => {
      const fragment = renderMentions("@alice and @bob");
      container.appendChild(fragment);

      const mentions = container.querySelectorAll(".mention");
      expect(mentions.length).toBe(2);
    });
  });

  describe("renderMessage", () => {
    it("renders a basic message with author and content", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(el.getAttribute("data-testid")).toBe("message-1");
      expect(container.querySelector(".msg-author")?.textContent).toBe("Alice");
      expect(container.querySelector(".msg-text")?.textContent).toBe("Hello world");

      ac.abort();
    });

    it("renders grouped messages with grouped class", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, true, [msg], makeOpts(), ac.signal);

      expect(el.classList.contains("grouped")).toBe(true);

      ac.abort();
    });

    it("renders deleted message with italic text", () => {
      const msg = makeMessage({ deleted: true });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const text = container.querySelector(".msg-text");
      expect(text?.textContent).toBe("[message deleted]");
      expect((text as HTMLElement)?.style.fontStyle).toBe("italic");

      ac.abort();
    });

    it("shows (edited) tag for edited messages", () => {
      const msg = makeMessage({ editedAt: "2025-01-15T13:00:00Z" });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const edited = container.querySelector(".msg-edited");
      expect(edited).not.toBeNull();
      expect(edited!.textContent).toBe("(edited)");

      ac.abort();
    });

    it("renders system messages differently", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "Alice joined the server",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".system-msg")).not.toBeNull();

      ac.abort();
    });

    it("renders reply reference when replyTo is set", () => {
      const original = makeMessage({ id: 1, content: "Original message" });
      const reply = makeMessage({ id: 2, replyTo: 1, content: "This is a reply" });
      const ac = new AbortController();
      const el = renderMessage(reply, false, [original, reply], makeOpts(), ac.signal);
      container.appendChild(el);

      const replyRef = container.querySelector(".msg-reply-ref");
      expect(replyRef).not.toBeNull();
      expect(replyRef!.querySelector(".rr-author")?.textContent).toBe("Alice");

      ac.abort();
    });

    it("shows action buttons for non-deleted messages", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const actionsBar = container.querySelector(".msg-actions-bar");
      expect(actionsBar).not.toBeNull();

      ac.abort();
    });

    it("does not show action buttons for deleted messages", () => {
      const msg = makeMessage({ deleted: true });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const actionsBar = container.querySelector(".msg-actions-bar");
      expect(actionsBar).toBeNull();

      ac.abort();
    });

    it("renders reactions when present", () => {
      const msg = makeMessage({
        reactions: [
          { emoji: "\uD83D\uDC4D", count: 3, me: false },
          { emoji: "\u2764\uFE0F", count: 1, me: true },
        ],
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const reactionChips = container.querySelectorAll(".reaction-chip:not(.add-reaction)");
      expect(reactionChips.length).toBe(2);

      ac.abort();
    });

    it("renders attachments for image types", () => {
      const msg = makeMessage({
        attachments: [
          { id: "1", filename: "photo.png", size: 1024, mime: "image/png", url: "/uploads/photo.png" },
        ],
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-image")).not.toBeNull();

      ac.abort();
    });

    it("renders attachments for file types", () => {
      const msg = makeMessage({
        attachments: [
          { id: "1", filename: "doc.pdf", size: 2048, mime: "application/pdf", url: "/uploads/doc.pdf" },
        ],
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-file")).not.toBeNull();
      expect(container.querySelector(".msg-file-name")?.textContent).toBe("doc.pdf");

      ac.abort();
    });
  });
});
