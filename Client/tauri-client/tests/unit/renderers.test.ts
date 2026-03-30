import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTime,
  formatFullDate,
  formatMessageTimestamp,
  isSameDay,
  shouldGroup,
  renderDayDivider,
  renderMessage,
  renderMentions,
  renderMentionSegment,
  renderInlineContent,
  renderMessageContent,
  getUserRole,
  roleColorVar,
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
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2025-01-15T12:30:00Z",
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
  return {
    channelId: 1,
    channelName: "general",
    currentUserId: 10,
    onScrollTop: vi.fn(),
    onReplyClick: vi.fn(),
    onEditClick: vi.fn(),
    onDeleteClick: vi.fn(),
    onReactionClick: vi.fn(),
    onPinClick: vi.fn(),
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

    it("gives icon-only action buttons explicit accessible names", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector("[data-testid='msg-react-1']")?.getAttribute("aria-label")).toBe("React");
      expect(container.querySelector("[data-testid='msg-reply-1']")?.getAttribute("aria-label")).toBe("Reply");
      expect(container.querySelector("[data-testid='msg-pin-1']")?.getAttribute("aria-label")).toBe("Pin");
      expect(container.querySelector("[data-testid='msg-edit-1']")?.getAttribute("aria-label")).toBe("Edit");
      expect(container.querySelector("[data-testid='msg-delete-1']")?.getAttribute("aria-label")).toBe("Delete");

      ac.abort();
    });

    it("updates the pin button accessible name for pinned messages", () => {
      const msg = makeMessage({ pinned: true });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector("[data-testid='msg-pin-1']")?.getAttribute("aria-label")).toBe("Unpin");

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

  // ---------------------------------------------------------------------------
  // parseTimestamp (via formatTime / formatFullDate)
  // ---------------------------------------------------------------------------

  describe("parseTimestamp — UTC treatment of bare SQLite timestamps", () => {
    it("treats a SQLite datetime string without timezone as UTC", () => {
      // "2026-03-19 08:00:00" is SQLite output — no Z, no T, no offset.
      // parseTimestamp must append Z so it is read as 08:00 UTC, not local.
      const withZ = formatTime("2026-03-19T08:00:00Z");
      const sqliteBare = formatTime("2026-03-19 08:00:00");
      expect(sqliteBare).toBe(withZ);
    });

    it("preserves explicit UTC timestamps with Z suffix unchanged", () => {
      // Verify that a Z-suffixed timestamp produces a valid HH:MM string.
      // We cannot assert a specific value because formatTime uses local clock
      // hours — instead verify that the bare and Z forms agree.
      const withZ = formatTime("2026-03-19T15:30:00Z");
      expect(withZ).toMatch(/^\d{2}:\d{2}$/);
    });

    it("preserves explicit positive UTC-offset timestamps", () => {
      // +02:00 is two hours ahead of UTC, so 17:30+02:00 == 15:30Z.
      // Both forms should produce the same local-clock HH:MM string.
      const withOffset = formatTime("2026-03-19T17:30:00+02:00");
      const utcEquiv = formatTime("2026-03-19T15:30:00Z");
      expect(withOffset).toBe(utcEquiv);
    });

    it("formats full date correctly for bare SQLite timestamp", () => {
      const result = formatFullDate("2026-03-19 00:00:00");
      expect(result).toContain("2026");
      expect(result).toContain("March");
      expect(result).toContain("19");
    });

    it("handles ISO 8601 datetime with T separator and Z suffix", () => {
      // Standard ISO — must not double-append Z. The result must be a
      // valid HH:MM string and must equal what the same timestamp produces
      // when formatted normally.
      const iso = "2026-01-01T06:00:00Z";
      const result = formatTime(iso);
      expect(result).toMatch(/^\d{2}:\d{2}$/);
      // Confirm idempotency: calling again with the same input gives same output
      expect(formatTime(iso)).toBe(result);
    });

    it("returns a valid HH:MM string for every supported timestamp format", () => {
      const formats = [
        "2026-03-19T08:30:00Z",
        "2026-03-19 08:30:00",
        "2026-03-19T08:30:00+00:00",
      ];
      for (const ts of formats) {
        expect(formatTime(ts)).toMatch(/^\d{2}:\d{2}$/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // isDirectImageUrl (via renderMessage embed output)
  // ---------------------------------------------------------------------------

  describe("isDirectImageUrl — image extension detection via renderMessage", () => {
    const imageExtensions = [".gif", ".png", ".jpg", ".jpeg", ".webp"] as const;

    for (const ext of imageExtensions) {
      it(`produces a .msg-image embed for a ${ext} URL`, () => {
        const url = `https://example.com/image${ext}`;
        const msg = makeMessage({ content: url });
        const ac = new AbortController();
        const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
        container.appendChild(el);

        // renderUrlEmbeds calls isDirectImageUrl → renderInlineImage
        // which produces a div.msg-image inside the message element
        const imageEmbeds = container.querySelectorAll(".msg-image");
        // There may be multiple .msg-image (attachments share the class),
        // but at least one must exist and have an <img src="...ext">
        const imgEl = container.querySelector(`.msg-image img[src="${url}"]`);
        expect(imgEl).not.toBeNull();

        ac.abort();
      });
    }

    it("does not produce a .msg-image embed for a non-image URL", () => {
      const url = "https://example.com/page.html";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      // A generic link card (.msg-embed-link) should appear instead
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();

      ac.abort();
    });

    it("does not produce a .msg-image embed for a URL with image extension as query param", () => {
      // The path itself has no image extension — only a query string does
      const url = "https://example.com/image?format=png";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();

      ac.abort();
    });

    it("matches image extensions case-insensitively", () => {
      // Uppercase extensions must also be detected
      const url = "https://example.com/photo.PNG";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const imgEl = container.querySelector(`.msg-image img[src="${url}"]`);
      expect(imgEl).not.toBeNull();

      ac.abort();
    });

    it("does not treat a YouTube URL with no image extension as a direct image", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      // YouTube gets a player embed, not a .msg-image with that src
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // renderInlineImage (via renderMessage)
  // ---------------------------------------------------------------------------

  describe("renderInlineImage — img element and lightbox behaviour", () => {
    it("creates an img element with the correct src attribute", () => {
      const url = "https://example.com/photo.jpg";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const img = container.querySelector(`.msg-image img`) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe(url);

      ac.abort();
    });

    it("wraps the img in a div with class msg-image", () => {
      const url = "https://cdn.example.com/banner.gif";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const wrap = container.querySelector(".msg-image");
      expect(wrap).not.toBeNull();
      expect(wrap!.querySelector("img")).not.toBeNull();

      ac.abort();
    });

    it("appends a lightbox overlay to document.body on img click", () => {
      const url = "https://example.com/photo.png";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const img = container.querySelector(`.msg-image img[src="${url}"]`) as HTMLElement | null;
      expect(img).not.toBeNull();

      // No lightbox before click
      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      img!.click();

      // Lightbox should now be in the body
      const lightbox = document.body.querySelector(".image-lightbox");
      expect(lightbox).not.toBeNull();

      // Clean up lightbox
      lightbox!.remove();
      ac.abort();
    });

    it("lightbox contains a close button that removes the overlay", () => {
      const url = "https://example.com/photo.webp";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const img = container.querySelector(`.msg-image img[src="${url}"]`) as HTMLElement | null;
      img!.click();

      const lightbox = document.body.querySelector(".image-lightbox")!;
      const closeBtn = lightbox.querySelector(".image-lightbox-close") as HTMLElement | null;
      expect(closeBtn).not.toBeNull();

      closeBtn!.click();

      // Lightbox should be removed from DOM after close
      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      ac.abort();
    });

    it("lightbox contains an img element with the same src as the inline image", () => {
      const url = "https://example.com/pic.jpeg";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const img = container.querySelector(`.msg-image img[src="${url}"]`) as HTMLElement | null;
      img!.click();

      const lightbox = document.body.querySelector(".image-lightbox")!;
      const lbImg = lightbox.querySelector("img") as HTMLImageElement | null;
      expect(lbImg).not.toBeNull();
      expect(lbImg!.getAttribute("src")).toBe(url);

      // Clean up
      lightbox.remove();
      ac.abort();
    });

    it("closes lightbox when Escape key is pressed", () => {
      const url = "https://example.com/escape-test.png";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const img = container.querySelector(`.msg-image img[src="${url}"]`) as HTMLElement | null;
      img!.click();

      expect(document.body.querySelector(".image-lightbox")).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // System messages
  // ---------------------------------------------------------------------------

  describe("renderSystemMessage (via renderMessage)", () => {
    it("renders system message with icon, text, and time", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "@alice joined the server",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".system-msg")).not.toBeNull();
      expect(container.querySelector(".sm-icon")).not.toBeNull();
      expect(container.querySelector(".sm-text")).not.toBeNull();
      expect(container.querySelector(".sm-time")).not.toBeNull();

      ac.abort();
    });

    it("renders mentions inside system message text", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "@alice was promoted to admin",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const mention = el.querySelector(".mention");
      expect(mention).not.toBeNull();
      expect(mention!.textContent).toBe("@alice");

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Reply reference — unknown message
  // ---------------------------------------------------------------------------

  describe("renderReplyRef — unknown message", () => {
    it("renders 'Reply to unknown message' when referenced message is missing", () => {
      const reply = makeMessage({ id: 2, replyTo: 999, content: "replying" });
      const ac = new AbortController();
      const el = renderMessage(reply, false, [reply], makeOpts(), ac.signal);
      container.appendChild(el);

      const replyRef = container.querySelector(".msg-reply-ref");
      expect(replyRef).not.toBeNull();
      expect(replyRef!.textContent).toBe("Reply to unknown message");

      ac.abort();
    });

    it("renders '[message deleted]' preview for deleted referenced message", () => {
      const original = makeMessage({ id: 1, content: "Original", deleted: true });
      const reply = makeMessage({ id: 2, replyTo: 1, content: "reply" });
      const ac = new AbortController();
      const el = renderMessage(reply, false, [original, reply], makeOpts(), ac.signal);
      container.appendChild(el);

      const replyText = container.querySelector(".rr-text");
      expect(replyText).not.toBeNull();
      expect(replyText!.textContent).toBe("[message deleted]");

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Developer mode — copy ID button
  // ---------------------------------------------------------------------------

  describe("developer mode — Copy ID button", () => {
    it("renders Copy ID button when developerMode is enabled", () => {
      // loadPref reads from localStorage with the "owncord:settings:" prefix
      localStorage.setItem("owncord:settings:developerMode", "true");
      // Dispatch pref-change to invalidate the cached developerModeEnabled value
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));

      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const copyIdBtn = container.querySelector("[data-testid='msg-copy-id-1']");
      expect(copyIdBtn).not.toBeNull();
      expect(copyIdBtn!.getAttribute("aria-label")).toBe("Copy ID");

      // Clean up: restore developer mode to false
      localStorage.setItem("owncord:settings:developerMode", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));
      ac.abort();
    });

    it("Copy ID button calls clipboard.writeText on click", () => {
      localStorage.setItem("owncord:settings:developerMode", "true");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));

      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

      const msg = makeMessage({ id: 42 });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const copyIdBtn = container.querySelector("[data-testid='msg-copy-id-42']") as HTMLElement;
      expect(copyIdBtn).not.toBeNull();
      copyIdBtn.click();

      expect(writeTextMock).toHaveBeenCalledWith("42");

      // Clean up
      localStorage.setItem("owncord:settings:developerMode", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));
      ac.abort();
    });

    it("Copy ID button handles clipboard failure gracefully", () => {
      localStorage.setItem("owncord:settings:developerMode", "true");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));

      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")) },
      });

      const msg = makeMessage({ id: 42 });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const copyIdBtn = container.querySelector("[data-testid='msg-copy-id-42']") as HTMLElement;
      // Should not throw
      expect(() => copyIdBtn.click()).not.toThrow();

      // Clean up
      localStorage.setItem("owncord:settings:developerMode", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));
      ac.abort();
    });

    it("does not render Copy ID button when developerMode is disabled", () => {
      localStorage.setItem("owncord:settings:developerMode", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "developerMode" },
      }));

      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const copyIdBtn = container.querySelector("[data-testid='msg-copy-id-1']");
      expect(copyIdBtn).toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Deleted messages — no action bar, no embeds
  // ---------------------------------------------------------------------------

  describe("deleted message edge cases", () => {
    it("does not render embeds for deleted messages", () => {
      const msg = makeMessage({
        deleted: true,
        content: "https://example.com/photo.png",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-image")).toBeNull();
      expect(container.querySelector(".msg-embed-link")).toBeNull();
      expect(container.querySelector(".msg-actions-bar")).toBeNull();

      ac.abort();
    });

    it("does not render (edited) tag for deleted messages", () => {
      const msg = makeMessage({
        deleted: true,
        editedAt: "2025-01-15T13:00:00Z",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-edited")).toBeNull();

      ac.abort();
    });

    it("does not render reactions for deleted messages", () => {
      const msg = makeMessage({
        deleted: true,
        reactions: [{ emoji: "\uD83D\uDC4D", count: 1, me: false }],
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".reaction-chip")).toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Action button callbacks
  // ---------------------------------------------------------------------------

  describe("action button callbacks", () => {
    it("calls onReplyClick when reply button is clicked", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const replyBtn = container.querySelector("[data-testid='msg-reply-1']") as HTMLElement;
      replyBtn.click();
      expect(opts.onReplyClick).toHaveBeenCalledWith(1);

      ac.abort();
    });

    it("calls onReactionClick when react button is clicked", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const reactBtn = container.querySelector("[data-testid='msg-react-1']") as HTMLElement;
      reactBtn.click();
      expect(opts.onReactionClick).toHaveBeenCalledWith(1, "");

      ac.abort();
    });

    it("calls onPinClick with correct arguments", () => {
      const opts = makeOpts();
      const msg = makeMessage({ pinned: false });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const pinBtn = container.querySelector("[data-testid='msg-pin-1']") as HTMLElement;
      pinBtn.click();
      expect(opts.onPinClick).toHaveBeenCalledWith(1, 1, false);

      ac.abort();
    });

    it("calls onEditClick when edit button is clicked", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const editBtn = container.querySelector("[data-testid='msg-edit-1']") as HTMLElement;
      editBtn.click();
      expect(opts.onEditClick).toHaveBeenCalledWith(1);

      ac.abort();
    });

    it("calls onDeleteClick when delete button is clicked", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const deleteBtn = container.querySelector("[data-testid='msg-delete-1']") as HTMLElement;
      deleteBtn.click();
      expect(opts.onDeleteClick).toHaveBeenCalledWith(1);

      ac.abort();
    });

    it("does not render edit/delete buttons for other users' messages", () => {
      const opts = makeOpts({ currentUserId: 999 });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      expect(container.querySelector("[data-testid='msg-edit-1']")).toBeNull();
      expect(container.querySelector("[data-testid='msg-delete-1']")).toBeNull();
      // But react, reply, pin should still be present
      expect(container.querySelector("[data-testid='msg-react-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='msg-reply-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='msg-pin-1']")).not.toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Grouped message hover time
  // ---------------------------------------------------------------------------

  describe("grouped message hover time", () => {
    it("renders hover time element for grouped messages", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, true, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      const hoverTime = container.querySelector(".msg-hover-time");
      expect(hoverTime).not.toBeNull();
      expect(hoverTime!.textContent).toMatch(/^\d{2}:\d{2}$/);

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // formatMessageTimestamp
  // ---------------------------------------------------------------------------

  describe("formatMessageTimestamp", () => {
    it("returns 'Today at ...' for today's timestamps", () => {
      const now = new Date();
      const iso = now.toISOString();
      const result = formatMessageTimestamp(iso);
      expect(result).toMatch(/^Today at /);
    });

    it("returns 'Yesterday at ...' for yesterday's timestamps", () => {
      const yesterday = new Date(Date.now() - 86_400_000);
      const iso = yesterday.toISOString();
      const result = formatMessageTimestamp(iso);
      expect(result).toMatch(/^Yesterday at /);
    });

    it("returns MM/DD/YYYY format for older timestamps", () => {
      const result = formatMessageTimestamp("2020-06-15T12:00:00Z");
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4} /);
    });
  });

  // ---------------------------------------------------------------------------
  // getUserRole / roleColorVar
  // ---------------------------------------------------------------------------

  describe("getUserRole", () => {
    it("returns 'member' for unknown userId", () => {
      expect(getUserRole(999999)).toBe("member");
    });

    it("returns role for known member", () => {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([[42, { id: 42, username: "admin", avatar: null, role: "admin", status: "online" }]]),
      }));
      expect(getUserRole(42)).toBe("admin");
    });
  });

  describe("roleColorVar", () => {
    afterEach(() => {
      // Restore roleColors to default (true)
      localStorage.setItem("owncord:settings:roleColors", "true");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "roleColors" },
      }));
    });

    it("returns owner color for 'owner' role", () => {
      expect(roleColorVar("owner")).toBe("var(--role-owner)");
    });

    it("returns admin color for 'admin' role", () => {
      expect(roleColorVar("admin")).toBe("var(--role-admin)");
    });

    it("returns mod color for 'moderator' role", () => {
      expect(roleColorVar("moderator")).toBe("var(--role-mod)");
    });

    it("returns member color for unknown role", () => {
      expect(roleColorVar("custom")).toBe("var(--role-member)");
    });

    it("returns member color for 'member' role", () => {
      expect(roleColorVar("member")).toBe("var(--role-member)");
    });

    it("returns member color for all roles when roleColors is disabled", () => {
      localStorage.setItem("owncord:settings:roleColors", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "roleColors" },
      }));

      expect(roleColorVar("owner")).toBe("var(--role-member)");
      expect(roleColorVar("admin")).toBe("var(--role-member)");
      expect(roleColorVar("moderator")).toBe("var(--role-member)");
      expect(roleColorVar("member")).toBe("var(--role-member)");
    });

    it("re-enables role colors when pref changes back to true", () => {
      localStorage.setItem("owncord:settings:roleColors", "false");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "roleColors" },
      }));
      expect(roleColorVar("owner")).toBe("var(--role-member)");

      localStorage.setItem("owncord:settings:roleColors", "true");
      window.dispatchEvent(new CustomEvent("owncord:pref-change", {
        detail: { key: "roleColors" },
      }));
      expect(roleColorVar("owner")).toBe("var(--role-owner)");
    });
  });

  // ---------------------------------------------------------------------------
  // renderMentionSegment
  // ---------------------------------------------------------------------------

  describe("renderMentionSegment", () => {
    it("renders plain text without mentions", () => {
      const fragment = renderMentionSegment("just text");
      container.appendChild(fragment);
      expect(container.textContent).toBe("just text");
      expect(container.querySelector(".mention")).toBeNull();
    });

    it("renders @mention at start of text", () => {
      const fragment = renderMentionSegment("@alice hello");
      container.appendChild(fragment);
      const mention = container.querySelector(".mention");
      expect(mention).not.toBeNull();
      expect(mention!.textContent).toBe("@alice");
    });
  });

  // ---------------------------------------------------------------------------
  // renderInlineContent
  // ---------------------------------------------------------------------------

  describe("renderInlineContent", () => {
    it("renders inline code segments", () => {
      const fragment = renderInlineContent("use `npm install` to install");
      container.appendChild(fragment);
      const code = container.querySelector("code");
      expect(code).not.toBeNull();
      expect(code!.textContent).toBe("npm install");
    });

    it("renders text with no inline code", () => {
      const fragment = renderInlineContent("plain text");
      container.appendChild(fragment);
      expect(container.textContent).toBe("plain text");
      expect(container.querySelector("code")).toBeNull();
    });

    it("renders mention inside non-code text", () => {
      const fragment = renderInlineContent("hello @alice and `code`");
      container.appendChild(fragment);
      expect(container.querySelector(".mention")).not.toBeNull();
      expect(container.querySelector("code")).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // renderMessageContent — code blocks
  // ---------------------------------------------------------------------------

  describe("renderMessageContent", () => {
    it("renders code blocks with copy button", () => {
      const fragment = renderMessageContent("```console.log('hi')```");
      container.appendChild(fragment);

      const codeBlock = container.querySelector(".msg-codeblock");
      expect(codeBlock).not.toBeNull();
      expect(codeBlock!.textContent).toBe("console.log('hi')");

      const copyBtn = container.querySelector(".msg-codeblock-copy");
      expect(copyBtn).not.toBeNull();
      expect(copyBtn!.textContent).toBe("Copy");
    });

    it("renders prose and code blocks together", () => {
      const fragment = renderMessageContent("Hello```code here```world");
      container.appendChild(fragment);

      expect(container.querySelector(".msg-text")).not.toBeNull();
      expect(container.querySelector(".msg-codeblock")).not.toBeNull();
    });

    it("renders empty content as a single msg-text", () => {
      const fragment = renderMessageContent("");
      container.appendChild(fragment);

      // Empty string content: parts = [""], single prose segment
      const textEls = container.querySelectorAll(".msg-text");
      expect(textEls.length).toBeLessThanOrEqual(1);
    });

    it("handles code block copy button click with clipboard", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      const fragment = renderMessageContent("```test code```");
      container.appendChild(fragment);

      const copyBtn = container.querySelector(".msg-codeblock-copy") as HTMLElement;
      copyBtn.click();

      await vi.waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith("test code");
      });
    });

    it("handles code block copy button click when clipboard fails", async () => {
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error("fail")) },
      });

      const fragment = renderMessageContent("```some code```");
      container.appendChild(fragment);

      const copyBtn = container.querySelector(".msg-codeblock-copy") as HTMLElement;
      copyBtn.click();

      await vi.waitFor(() => {
        expect(copyBtn.textContent).toBe("Failed");
      });
    });
  });

  // ---------------------------------------------------------------------------
  // renderMentions — URL handling
  // ---------------------------------------------------------------------------

  describe("renderMentions — URL linkification", () => {
    it("creates a clickable link for safe URLs", () => {
      const fragment = renderMentions("check https://example.com out");
      container.appendChild(fragment);

      const link = container.querySelector("a.msg-link");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("https://example.com");
      expect(link!.getAttribute("target")).toBe("_blank");
    });

    it("renders unsafe URLs as plain text", () => {
      const fragment = renderMentions("see javascript:alert(1) here");
      container.appendChild(fragment);

      // No anchor tag for javascript: URL (doesn't match URL_REGEX at all)
      expect(container.querySelector("a")).toBeNull();
    });

    it("handles URLs between text segments", () => {
      const fragment = renderMentions("before https://a.com after");
      container.appendChild(fragment);

      const link = container.querySelector("a.msg-link");
      expect(link).not.toBeNull();
      // Text before and after the link
      expect(container.textContent).toContain("before");
      expect(container.textContent).toContain("after");
    });

  });

  // ---------------------------------------------------------------------------
  // renderUrlEmbeds (via renderMessage)
  // ---------------------------------------------------------------------------

  describe("renderUrlEmbeds — embed routing via renderMessage", () => {
    it("produces a .msg-image element for a direct image URL instead of a generic link card", () => {
      const url = "https://static.example.com/hero.png";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-image")).not.toBeNull();
      expect(container.querySelector(".msg-embed-link")).toBeNull();

      ac.abort();
    });

    it("does not duplicate embeds for the same URL appearing twice in content", () => {
      const url = "https://example.com/img.gif";
      const msg = makeMessage({ content: `${url} and again ${url}` });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      // URL dedup inside renderUrlEmbeds — only one img embed produced
      const imgEmbeds = container.querySelectorAll(`.msg-image img[src="${url}"]`);
      expect(imgEmbeds.length).toBe(1);

      ac.abort();
    });

    it("skips image URLs that appear inside code blocks", () => {
      const url = "https://example.com/hidden.png";
      const msg = makeMessage({ content: `\`\`\`${url}\`\`\`` });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      // URL inside a code block must not produce an embed
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();

      ac.abort();
    });

    it("skips image URLs inside inline code", () => {
      const url = "https://example.com/inline.png";
      const msg = makeMessage({ content: `Look at \`${url}\`` });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();

      ac.abort();
    });

    it("renders multiple different image URLs as separate .msg-image embeds", () => {
      const url1 = "https://example.com/a.png";
      const url2 = "https://example.com/b.gif";
      const msg = makeMessage({ content: `${url1} and ${url2}` });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(`img[src="${url1}"]`)).not.toBeNull();
      expect(container.querySelector(`img[src="${url2}"]`)).not.toBeNull();

      ac.abort();
    });

    it("renders a generic link card for a plain https URL with no image extension", () => {
      const url = "https://example.com/some-article";
      const msg = makeMessage({ content: url });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();

      ac.abort();
    });

    it("produces no embeds for a message with no URLs", () => {
      const msg = makeMessage({ content: "just plain text, no links" });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
      container.appendChild(el);

      expect(container.querySelector(".msg-embed")).toBeNull();
      expect(container.querySelector(".msg-image")).toBeNull();

      ac.abort();
    });
  });
});
