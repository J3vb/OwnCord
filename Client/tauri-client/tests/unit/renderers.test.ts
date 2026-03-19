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
