import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/renderersMocks";
import {
  formatTime,
  formatFullDate,
  isSameDay,
  shouldGroup,
  renderDayDivider,
  renderMessage,
  renderMentions,
} from "../../../src/components/message-list/renderers";
import {
  clearReactionUsersCache,
  setReactionUsersFetcher,
} from "../../../src/features/messaging/reactionUsers";
import { expectConsole } from "../../helpers/console";
import {
  seedMessageManager,
  seedMentionMembers,
  makeMessage,
  makeOpts,
  useRenderersHarness,
  mountMessage,
} from "../../helpers/renderersHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../../src/platform/desktop/externalContent", () => mocks.desktopExternalContentMock());

describe("renderers", () => {
  let container: HTMLDivElement;
  useRenderersHarness((el) => {
    container = el;
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
      expect(
        isSameDay(new Date(2025, 0, 15, 8).toISOString(), new Date(2025, 0, 15, 20).toISOString()),
      ).toBe(true);
    });

    it("returns false for timestamps on different days", () => {
      expect(
        isSameDay(new Date(2025, 0, 15, 8).toISOString(), new Date(2025, 0, 16, 8).toISOString()),
      ).toBe(false);
    });
  });

  describe("shouldGroup", () => {
    it("returns true for same user within threshold", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({ id: 2, timestamp: "2025-01-15T12:04:00Z" });
      expect(shouldGroup(prev, curr)).toBe(true);
    });

    it("returns false for a same-author reply within the threshold", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({ id: 2, replyTo: 1, timestamp: "2025-01-15T12:02:00Z" });
      expect(shouldGroup(prev, curr)).toBe(false);
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

    it("groups a same-author pair 6 minutes apart (inside the 7-minute window)", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({ id: 2, timestamp: "2025-01-15T12:06:00Z" });
      expect(shouldGroup(prev, curr)).toBe(true);
    });

    it("does not group a pair exactly 7:00 apart (the window is exclusive)", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({ id: 2, timestamp: "2025-01-15T12:07:00Z" });
      expect(shouldGroup(prev, curr)).toBe(false);
    });

    it("returns false when time difference exceeds threshold", () => {
      const prev = makeMessage({ timestamp: "2025-01-15T12:00:00Z" });
      const curr = makeMessage({
        id: 2,
        timestamp: "2025-01-15T12:08:00Z",
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
    it("wraps resolvable @mentions in span with mention class", () => {
      seedMentionMembers();
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
      seedMentionMembers();
      const fragment = renderMentions("@alice and @bob");
      container.appendChild(fragment);

      const mentions = container.querySelectorAll(".mention");
      expect(mentions.length).toBe(2);
    });
  });

  describe("renderMessage", () => {
    it("renders a basic message with author and content", () => {
      const msg = makeMessage();
      const { el, ac } = mountMessage(container, msg);

      expect(el.getAttribute("data-testid")).toBe("message-1");
      expect(container.querySelector(".msg-author")?.textContent).toBe("Alice");
      expect(container.querySelector(".msg-text")?.textContent).toBe("Hello world");

      ac.abort();
    });

    it("frames a forwarded message's body and files, with reactions outside the frame", () => {
      const msg = makeMessage({
        content: "snapshot text",
        forward: {
          source_channel_id: 5,
          source_message_id: 9,
          source_timestamp: "2025-01-10T09:00:00Z",
        },
        reactions: [{ emoji: "👍", count: 1, me: false }],
      });
      const { el, ac } = mountMessage(container, msg);

      const box = el.querySelector(".msg-forward");
      expect(box?.querySelector(".msg-forward-head")?.textContent).toBe("Forwarded");
      expect(box?.querySelector(".msg-text")?.textContent).toBe("snapshot text");
      expect(el.querySelector(".msg-reactions")?.closest(".msg-forward")).toBeNull();

      ac.abort();
    });

    it("draws an ordinary message without the frame", () => {
      const msg = makeMessage();
      const { ac } = mountMessage(container, msg);
      expect(container.querySelector(".msg-forward")).toBeNull();
      ac.abort();
    });

    it("marks the author name and avatar as a keyboard-reachable profile control", () => {
      const msg = makeMessage({ user: { id: 42, username: "Alice", avatar: null } });
      const { ac } = mountMessage(container, msg);

      const author = container.querySelector(".msg-author");
      expect(author?.getAttribute("data-user-id")).toBe("42");
      expect(author?.getAttribute("role")).toBe("button");
      expect(author?.getAttribute("tabindex")).toBe("0");
      expect(container.querySelector(".msg-avatar")?.getAttribute("data-user-id")).toBe("42");

      ac.abort();
    });

    it("keeps Report off the hover bar: it lives in the message menu", () => {
      const ac = new AbortController();
      const theirs = renderMessage(
        makeMessage({ id: 5, user: { id: 11, username: "Bob", avatar: null } }),
        false,
        [],
        makeOpts({ onReportClick: vi.fn() }),
        ac.signal,
      );
      expect(theirs.querySelector("[data-testid^='msg-report-']")).toBeNull();
      ac.abort();
    });

    it("renders grouped messages with grouped class", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, true, [msg], makeOpts(), ac.signal);

      expect(el.classList.contains("grouped")).toBe(true);

      ac.abort();
    });

    it("marks a pending optimistic row and hides the action bar", () => {
      const msg = makeMessage({ status: "pending", correlationId: "c1", id: 0 });
      const { el, ac } = mountMessage(container, msg);

      expect(el.classList.contains("pending")).toBe(true);
      // No hover actions on an unsent row.
      expect(container.querySelector(".msg-actions-bar")).toBeNull();

      ac.abort();
    });

    it("explains a REQUEST_TIMEOUT failure as a busy server and keeps Retry", () => {
      const msg = makeMessage({
        status: "failed",
        correlationId: "c-busy",
        id: 0,
        errorCode: "REQUEST_TIMEOUT",
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe(
        "The server is busy — retry in a moment",
      );
      expect(container.querySelector('[data-testid="msg-retry-c-busy"]')).not.toBeNull();
      ac.abort();
    });

    it("renders a failed row with reason, retry, and discard", () => {
      const onRetry = vi.fn();
      const onDeleteDraft = vi.fn();
      const msg = makeMessage({
        status: "failed",
        correlationId: "c1",
        id: 0,
        errorCode: "SLOW_MODE",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts({ onRetry, onDeleteDraft }), ac.signal);
      container.appendChild(el);

      expect(el.classList.contains("failed")).toBe(true);
      expect(container.querySelector(".msg-send-failed-text")?.textContent).toContain("Slow mode");

      const retry = container.querySelector<HTMLButtonElement>('[data-testid="msg-retry-c1"]');
      const discard = container.querySelector<HTMLButtonElement>('[data-testid="msg-discard-c1"]');
      expect(retry).not.toBeNull();
      expect(discard).not.toBeNull();

      retry!.click();
      discard!.click();
      expect(onRetry).toHaveBeenCalledWith("c1");
      expect(onDeleteDraft).toHaveBeenCalledWith("c1");

      ac.abort();
    });

    it("renders an uploading row as pending, with the strip from the hook and no bars", () => {
      const strip = document.createElement("div");
      strip.className = "msg-upload-strip";
      const renderUploadStrip = vi.fn((_cid: string, _signal: AbortSignal) => strip);
      const msg = makeMessage({ status: "uploading", correlationId: "u1", id: 0 });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts({ renderUploadStrip }), ac.signal);
      container.appendChild(el);

      expect(el.classList.contains("pending")).toBe(true);
      expect(el.classList.contains("failed")).toBe(false);
      expect(el.querySelector(".msg-upload-strip")).toBe(strip);
      // The strip belongs to the row's render: it gets the row's own signal.
      expect(renderUploadStrip).toHaveBeenCalledWith("u1", ac.signal);
      expect(container.querySelector(".msg-actions-bar")).toBeNull();
      expect(container.querySelector(".msg-send-failed")).toBeNull();

      ac.abort();
    });

    it("gives the uploading row's text an id its Cancel button describes itself by", async () => {
      const { renderUploadStrip: realStrip } =
        await import("../../../src/features/messaging/sendQueue");
      const entry = {
        cid: "u1",
        channelId: 1,
        userId: 1,
        content: "hello",
        replyTo: null,
        replyPing: false,
        items: [{ filename: "a.pdf" }],
      };
      const msg = makeMessage({
        status: "uploading",
        correlationId: "u1",
        id: 0,
        content: "hello",
      });
      const ac = new AbortController();
      const el = renderMessage(
        msg,
        false,
        [msg],
        makeOpts({ renderUploadStrip: (_cid, signal) => realStrip(entry, signal) }),
        ac.signal,
      );
      container.appendChild(el);

      const cancel = el.querySelector(".msg-upload-cancel")!;
      const target = el.querySelector(`#msg-body-u1`);
      expect(cancel.getAttribute("aria-describedby")).toContain("msg-body-u1");
      expect(target?.textContent).toContain("hello");

      ac.abort();
    });

    it("renders an uploading row without a strip when the host has none", () => {
      const msg = makeMessage({ status: "uploading", correlationId: "u1", id: 0 });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);

      expect(el.classList.contains("pending")).toBe(true);
      expect(el.querySelector(".msg-upload-strip")).toBeNull();

      ac.abort();
    });

    it("keeps the strip on a failed queued row, above 'Upload failed' with Retry and Delete", () => {
      const strip = document.createElement("div");
      strip.className = "msg-upload-strip";
      const renderUploadStrip = vi.fn(() => strip);
      const msg = makeMessage({
        status: "failed",
        correlationId: "u2",
        id: 0,
        errorCode: "UPLOAD_FAILED",
      });
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts({ renderUploadStrip }), ac.signal);
      container.appendChild(el);

      expect(el.querySelector(".msg-upload-strip")).toBe(strip);
      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe("Upload failed");
      expect(container.querySelector('[data-testid="msg-retry-u2"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="msg-discard-u2"]')).not.toBeNull();
      // The strip comes before the failed bar.
      expect(
        strip.compareDocumentPosition(container.querySelector(".msg-send-failed")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      ac.abort();
    });

    it("names a cancelled upload on the failed bar", () => {
      const msg = makeMessage({
        status: "failed",
        correlationId: "u3",
        id: 0,
        errorCode: "UPLOAD_CANCELLED",
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe(
        "Upload cancelled",
      );

      ac.abort();
    });

    it("renders a transport-failure (NETWORK) row with the connection-problem reason", () => {
      const msg = makeMessage({
        status: "failed",
        correlationId: "c2",
        id: 0,
        errorCode: "NETWORK",
      });
      const { el, ac } = mountMessage(container, msg);

      expect(el.classList.contains("failed")).toBe(true);
      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe(
        "Connection problem — delivery not confirmed",
      );

      ac.abort();
    });

    it("says an unsaved offline message is lost at restart, not merely unconfirmed", () => {
      // The row is failed and never handed to a socket: retrying is the only
      // way to get the text out, so the reason must not read like the ordinary
      // offline case where the saved copy still recovers it.
      const msg = makeMessage({
        status: "failed",
        correlationId: "c3",
        id: 0,
        errorCode: "OFFLINE_NO_RECOVERY",
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe(
        "Could not save this message — retry now or it is lost on restart",
      );

      ac.abort();
    });

    it("says a refused pre-restore retry was caused by the restore", () => {
      const msg = makeMessage({
        status: "failed",
        correlationId: "c4",
        id: 0,
        content: "queued before the restore",
        errorCode: "BEFORE_RESTORE",
      });
      const { el, ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-send-failed-text")?.textContent).toBe(
        "The server was restored — check the conversation before sending this again.",
      );
      expect(el.textContent).toContain("queued before the restore");

      ac.abort();
    });

    it("renders deleted message with italic text", () => {
      const msg = makeMessage({ deleted: true });
      const { ac } = mountMessage(container, msg);

      const text = container.querySelector(".msg-text");
      expect(text?.textContent).toBe("[message deleted]");
      expect((text as HTMLElement)?.style.fontStyle).toBe("italic");

      ac.abort();
    });

    it("shows (edited) tag for edited messages", () => {
      const msg = makeMessage({ editedAt: "2025-01-15T13:00:00Z" });
      const { ac } = mountMessage(container, msg);

      const edited = container.querySelector(".msg-edited");
      expect(edited).not.toBeNull();
      expect(edited!.textContent).toBe("(edited)");

      ac.abort();
    });

    it("gives the header time and (edited) a weekday, date and time tooltip", () => {
      const msg = makeMessage({
        timestamp: "2025-01-15T12:00:00Z",
        editedAt: "2025-01-16T13:05:00Z",
      });
      const { ac } = mountMessage(container, msg);

      const full = /^\w+day, \w+ \d{1,2}, \d{4}( at |, )\d{1,2}:\d{2}\s?(AM|PM)$/;
      const timeTitle = container.querySelector(".msg-time")?.getAttribute("title") ?? "";
      const editedTitle = container.querySelector(".msg-edited")?.getAttribute("title") ?? "";
      expect(timeTitle).toMatch(full);
      expect(timeTitle).toMatch(/Wednesday, January 15, 2025|Wednesday, January 1[45], 2025/);
      expect(editedTitle).toMatch(full);
      expect(editedTitle).toMatch(/Thursday, January 1[67], 2025/);
      expect(editedTitle).not.toBe(timeTitle);

      ac.abort();
    });

    it("renders system messages differently", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "Alice joined the server",
      });
      const { ac } = mountMessage(container, msg);

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

    it("renders the reply preview as plain text, not raw markdown (F24)", () => {
      const original = makeMessage({ id: 1, content: "**bold** and `code`" });
      const reply = makeMessage({ id: 2, replyTo: 1, content: "This is a reply" });
      const ac = new AbortController();
      container.appendChild(renderMessage(reply, false, [original, reply], makeOpts(), ac.signal));

      const preview = container.querySelector(".msg-reply-ref .rr-text")!.textContent;
      expect(preview).not.toContain("**");
      expect(preview).toContain("bold");

      ac.abort();
    });

    it("shows action buttons for non-deleted messages", () => {
      const msg = makeMessage();
      const { ac } = mountMessage(container, msg);

      const actionsBar = container.querySelector(".msg-actions-bar");
      expect(actionsBar).not.toBeNull();

      ac.abort();
    });

    it("gives icon-only action buttons explicit accessible names", () => {
      seedMessageManager();
      const msg = makeMessage();
      const { ac } = mountMessage(container, msg);

      expect(
        container.querySelector("[data-testid='msg-react-1']")?.getAttribute("aria-label"),
      ).toBe("React");
      expect(
        container.querySelector("[data-testid='msg-reply-1']")?.getAttribute("aria-label"),
      ).toBe("Reply");
      expect(container.querySelector("[data-testid='msg-pin-1']")?.getAttribute("aria-label")).toBe(
        "Pin",
      );
      expect(
        container.querySelector("[data-testid='msg-edit-1']")?.getAttribute("aria-label"),
      ).toBe("Edit");
      expect(
        container.querySelector("[data-testid='msg-delete-1']")?.getAttribute("aria-label"),
      ).toBe("Delete");

      ac.abort();
    });

    it("updates the pin button accessible name for pinned messages", () => {
      seedMessageManager();
      const msg = makeMessage({ pinned: true });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector("[data-testid='msg-pin-1']")?.getAttribute("aria-label")).toBe(
        "Unpin",
      );

      ac.abort();
    });

    it("does not show action buttons for deleted messages", () => {
      const msg = makeMessage({ deleted: true });
      const { ac } = mountMessage(container, msg);

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
      const { ac } = mountMessage(container, msg);

      const reactionChips = container.querySelectorAll(".reaction-chip:not(.add-reaction)");
      expect(reactionChips.length).toBe(2);

      ac.abort();
    });

    // The who-reacted tooltip hangs off the pill, so the pill has to carry its
    // emoji and be focusable for a keyboard user to reach the tooltip at all.
    it("makes reaction pills focusable and tags them with their emoji", () => {
      const msg = makeMessage({
        reactions: [{ emoji: "\uD83D\uDC4D", count: 3, me: false }],
      });
      const { ac } = mountMessage(container, msg);

      const chip = container.querySelector(
        ".reaction-chip:not(.add-reaction)",
      ) as HTMLElement | null;
      expect(chip?.dataset.emoji).toBe("\uD83D\uDC4D");
      expect(chip?.getAttribute("tabindex")).toBe("0");

      ac.abort();
    });

    it("shows the who-reacted tooltip after hovering a pill", async () => {
      setReactionUsersFetcher(() =>
        Promise.resolve([
          { id: 1, username: "alice", avatar: "" },
          { id: 2, username: "bob", avatar: "" },
        ]),
      );
      clearReactionUsersCache();

      const msg = makeMessage({
        reactions: [{ emoji: "\uD83D\uDC4D", count: 2, me: false }],
      });
      const { ac } = mountMessage(container, msg);

      const chip = container.querySelector(".reaction-chip:not(.add-reaction)") as HTMLElement;
      chip.dispatchEvent(new Event("mouseenter"));

      await vi.waitFor(() => {
        expect(chip.querySelector(".reaction-tooltip-names")?.textContent).toBe("alice and bob");
      });

      ac.abort();
      setReactionUsersFetcher(null);
    });

    it("renders attachments for image types", async () => {
      const msg = makeMessage({
        attachments: [
          {
            id: "1",
            filename: "photo.png",
            size: 1024,
            mime: "image/png",
            url: "/uploads/photo.png",
          },
        ],
      });
      const { ac } = mountMessage(container, msg);
      await vi.waitFor(() => {
        expectConsole("error", "[attachments] Failed to fetch attachment image");
      });

      expect(container.querySelector(".msg-image")).not.toBeNull();

      ac.abort();
    });

    it("renders attachments for file types", () => {
      const msg = makeMessage({
        attachments: [
          {
            id: "1",
            filename: "doc.pdf",
            size: 2048,
            mime: "application/pdf",
            url: "/uploads/doc.pdf",
          },
        ],
      });
      const { ac } = mountMessage(container, msg);

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
      // Midday UTC, not midnight: formatFullDate renders in the local zone, and
      // a UTC-midnight fixture rolls back to the 18th in any zone west of UTC
      // (e.g. America/New_York). Noon UTC stays on the 19th for every zone
      // from UTC-11 to UTC+11, which covers every developer/CI machine zone
      // (only the rare UTC+12..+14 Pacific zones roll it forward to the 20th).
      const result = formatFullDate("2026-03-19 12:00:00");
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
      const formats = ["2026-03-19T08:30:00Z", "2026-03-19 08:30:00", "2026-03-19T08:30:00+00:00"];
      for (const ts of formats) {
        expect(formatTime(ts)).toMatch(/^\d{2}:\d{2}$/);
      }
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
      const { ac } = mountMessage(container, msg);

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
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-edited")).toBeNull();

      ac.abort();
    });

    it("does not render reactions for deleted messages", () => {
      const msg = makeMessage({
        deleted: true,
        reactions: [{ emoji: "\uD83D\uDC4D", count: 1, me: false }],
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".reaction-chip")).toBeNull();

      ac.abort();
    });
  });
});
