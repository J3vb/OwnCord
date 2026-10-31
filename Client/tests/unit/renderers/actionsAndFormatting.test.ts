import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/renderersMocks";
import {
  formatMessageTimestamp,
  renderMessage,
  renderMentions,
  renderMentionSegment,
  renderInlineContent,
  renderMessageContent,
  getUserRole,
  roleColorVar,
} from "../../../src/components/message-list/renderers";
import { membersStore } from "../../../src/stores/members.store";
import { setRoles } from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { setConnectionStatus } from "../../../src/stores/ui.store";
import { shellText } from "../../../src/i18n/shell";
import { formatClockTime, userRoleColorVar } from "../../../src/lib/text/formatting";
import { restoreTZ, tzPinHonored } from "../../helpers/tz-pin";
import {
  resetStores,
  seedMessageManager,
  seedMentionMembers,
  makeMessage,
  makeOpts,
  useRenderersHarness,
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
      seedMessageManager();
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

    it("calls onDeleteClick with shiftKey=false when delete button is clicked", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const deleteBtn = container.querySelector("[data-testid='msg-delete-1']") as HTMLElement;
      deleteBtn.click();
      expect(opts.onDeleteClick).toHaveBeenCalledWith(1, false);

      ac.abort();
    });

    it("passes the shift state through to onDeleteClick", () => {
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], opts, ac.signal);
      container.appendChild(el);

      const deleteBtn = container.querySelector("[data-testid='msg-delete-1']") as HTMLElement;
      deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      expect(opts.onDeleteClick).toHaveBeenCalledWith(1, true);

      ac.abort();
    });

    it("disables delete with the connection reason while the socket is down", () => {
      setConnectionStatus("reconnecting");
      const opts = makeOpts();
      const msg = makeMessage();
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

      const deleteBtn = container.querySelector(
        "[data-testid='msg-delete-1']",
      ) as HTMLButtonElement;
      expect(deleteBtn.disabled).toBe(true);
      expect(deleteBtn.getAttribute("aria-disabled")).toBe("true");
      expect(deleteBtn.title).toBe(shellText("channel.reconnecting"));
      deleteBtn.dispatchEvent(new MouseEvent("click"));
      expect(opts.onDeleteClick).not.toHaveBeenCalled();

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
      // React and reply stay available to everyone; Pin follows the server's
      // MANAGE_MESSAGES gate and is withheld like delete (F1).
      expect(container.querySelector("[data-testid='msg-react-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='msg-reply-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='msg-pin-1']")).toBeNull();

      ac.abort();
    });

    it("offers delete on others' messages to a role with MANAGE_MESSAGES", () => {
      // MANAGE_MESSAGES = 0x10000 (see lib/types Permission).
      setRoles([{ id: 2, name: "moderator", color: null, permissions: 0x10000 }]);
      authStore.setState(() => ({
        token: "tok",
        user: { id: 999, username: "Mod", avatar: null, role: "moderator" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));

      const opts = makeOpts({ currentUserId: 999 });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

      expect(container.querySelector("[data-testid='msg-delete-1']")).not.toBeNull();
      // Editing someone else's message is still not a thing.
      expect(container.querySelector("[data-testid='msg-edit-1']")).toBeNull();

      ac.abort();
    });

    it("withholds delete from a role without MANAGE_MESSAGES", () => {
      setRoles([{ id: 3, name: "member", color: null, permissions: 0 }]);
      authStore.setState(() => ({
        token: "tok",
        user: { id: 999, username: "Nobody", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));

      const opts = makeOpts({ currentUserId: 999 });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

      expect(container.querySelector("[data-testid='msg-delete-1']")).toBeNull();

      ac.abort();
    });

    it("withholds Pin from a member without MANAGE_MESSAGES (F1)", () => {
      // The server gates SetMessagePinned on MANAGE_MESSAGES, so offering
      // Pin to a plain member is a broken affordance on every message.
      setRoles([{ id: 3, name: "member", color: null, permissions: 0 }]);
      authStore.setState(() => ({
        token: "tok",
        user: { id: 999, username: "Nobody", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));

      const opts = makeOpts({ currentUserId: 999 });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

      expect(container.querySelector("[data-testid='msg-pin-1']")).toBeNull();
      // React/Reply stay available to everyone.
      expect(container.querySelector("[data-testid='msg-react-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='msg-reply-1']")).not.toBeNull();

      ac.abort();
    });

    it("offers Pin to a role with MANAGE_MESSAGES", () => {
      setRoles([{ id: 2, name: "moderator", color: null, permissions: 0x10000 }]);
      authStore.setState(() => ({
        token: "tok",
        user: { id: 999, username: "Mod", avatar: null, role: "moderator" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));

      const opts = makeOpts({ currentUserId: 999 });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

      expect(container.querySelector("[data-testid='msg-pin-1']")).not.toBeNull();

      ac.abort();
    });

    it("offers Pin to a DM participant without MANAGE_MESSAGES (F1)", () => {
      // The server lets any DM participant pin (SetMessagePinned's DM branch),
      // so the gate must not hide it there.
      setRoles([{ id: 3, name: "member", color: null, permissions: 0 }]);
      authStore.setState(() => ({
        token: "tok",
        user: { id: 999, username: "Nobody", avatar: null, role: "member" },
        serverName: null,
        motd: null,
        isAuthenticated: true,
      }));

      const opts = makeOpts({ currentUserId: 999, channelType: "dm" });
      const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));

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
      // The header's clock time (F24), without "Today at", which wrapped
      // over the avatar column.
      expect(hoverTime!.textContent).toBe(formatClockTime(msg.timestamp));
      expect(hoverTime!.textContent).not.toMatch(/today|yesterday/i);

      ac.abort();
    });
  });

  describe("compact header time", () => {
    it("renders the short clock time before the author, titled with the full date", () => {
      const msg = makeMessage();
      const ac = new AbortController();
      container.appendChild(renderMessage(msg, false, [msg], makeOpts(), ac.signal));

      const compact = container.querySelector<HTMLElement>(".msg-header .msg-compact-time");
      expect(compact).not.toBeNull();
      expect(compact!.textContent).toBe(formatClockTime(msg.timestamp));
      expect(compact!.title).toBe(container.querySelector<HTMLElement>(".msg-time")!.title);
      expect(compact!.nextElementSibling?.classList.contains("msg-author")).toBe(true);

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

  // Probe once, before the suite is even registered: `process.env.TZ`
  // mutations only reach Date's local-time engine on a process main thread.
  // A worker-thread pool spawns an isolate that never observes the change,
  // even though the assignment itself succeeds — which used to skip this
  // block silently. vitest.config.ts pins a process pool and the probe now
  // throws instead of skipping, except under the one sanctioned opt-out
  // (Stryker, which hard-codes a thread pool). See helpers/tz-pin.ts.
  const dstTZPinHonored = tzPinHonored(
    "America/New_York",
    () =>
      new Date(2026, 0, 15).getTimezoneOffset() === 300 &&
      new Date(2026, 6, 15).getTimezoneOffset() === 240,
  );

  describe.skipIf(!dstTZPinHonored)("formatMessageTimestamp — DST day boundaries", () => {
    // These cases only exist in a DST-observing zone, so pin one for the
    // duration of this block. The precondition assertion in each test is
    // cheap insurance against the pin drifting mid-run.
    const originalTZ = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = "America/New_York";
      vi.useFakeTimers();
    });

    // restoreTZ, not a bare delete: deleting TZ leaves Date pinned to New York
    // for the rest of this forked worker's life, and vitest reuses a worker
    // across test files. See helpers/tz-pin.ts.
    afterEach(() => {
      vi.useRealTimers();
      restoreTZ(originalTZ);
    });

    function assertEasternTime(): void {
      // EST is UTC-5 (offset 300), EDT is UTC-4 (offset 240). If these differ
      // the runtime is genuinely observing DST transitions.
      expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
      expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
    }

    it("does not label a two-day-old message 'Yesterday' across spring forward", () => {
      assertEasternTime();
      // DST starts Sun Mar 8, 2026 (23-hour local day). Now: Mon Mar 9, 11:00 EDT.
      vi.setSystemTime(new Date("2026-03-09T15:00:00Z"));
      // Sat Mar 7, 23:30 EST — two calendar days before "today".
      const result = formatMessageTimestamp("2026-03-08T04:30:00Z");
      expect(result).not.toMatch(/^Yesterday/);
      expect(result).toMatch(/^03\/07\/2026 /);
      // Sun Mar 8, 08:00 EDT really is yesterday.
      expect(formatMessageTimestamp("2026-03-08T12:00:00Z")).toMatch(/^Yesterday at /);
    });

    it("labels the whole previous calendar day 'Yesterday' across fall back", () => {
      assertEasternTime();
      // DST ends Sun Nov 1, 2026 (25-hour local day). Now: Mon Nov 2, 10:00 EST.
      vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
      // Sun Nov 1, 00:30 EDT — inside the previous calendar day.
      expect(formatMessageTimestamp("2026-11-01T04:30:00Z")).toMatch(/^Yesterday at /);
      // Sat Oct 31, 23:30 EDT — two calendar days back stays absolute.
      expect(formatMessageTimestamp("2026-11-01T03:30:00Z")).toMatch(/^10\/31\/2026 /);
    });

    it("keeps Today/Yesterday/absolute labels on an ordinary day", () => {
      assertEasternTime();
      // Wed Jun 17, 2026, 11:00 EDT — nowhere near a DST transition.
      vi.setSystemTime(new Date("2026-06-17T15:00:00Z"));
      expect(formatMessageTimestamp("2026-06-17T14:00:00Z")).toMatch(/^Today at /);
      expect(formatMessageTimestamp("2026-06-17T03:30:00Z")).toMatch(/^Yesterday at /);
      expect(formatMessageTimestamp("2026-06-15T16:00:00Z")).toMatch(/^06\/15\/2026 /);
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
        members: new Map([
          [42, { id: 42, username: "admin", avatar: null, role: "admin", status: "online" }],
        ]),
      }));
      expect(getUserRole(42)).toBe("admin");
    });
  });

  describe("roleColorVar", () => {
    afterEach(() => {
      // Restore roleColors to default (true)
      localStorage.setItem("owncord:settings:roleColors", "true");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", {
          detail: { key: "roleColors" },
        }),
      );
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
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", {
          detail: { key: "roleColors" },
        }),
      );

      expect(roleColorVar("owner")).toBe("var(--role-member)");
      expect(roleColorVar("admin")).toBe("var(--role-member)");
      expect(roleColorVar("moderator")).toBe("var(--role-member)");
      expect(roleColorVar("member")).toBe("var(--role-member)");
    });

    it("re-enables role colors when pref changes back to true", () => {
      localStorage.setItem("owncord:settings:roleColors", "false");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", {
          detail: { key: "roleColors" },
        }),
      );
      expect(roleColorVar("owner")).toBe("var(--role-member)");

      localStorage.setItem("owncord:settings:roleColors", "true");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", {
          detail: { key: "roleColors" },
        }),
      );
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
      seedMentionMembers();
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
      seedMentionMembers();
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

    it("keeps a balanced trailing paren that is part of the URL", () => {
      const url = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
      const fragment = renderMentions(url);
      container.appendChild(fragment);

      const link = container.querySelector("a.msg-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute("href")).toBe(url);
      expect(link.textContent).toBe(url);
      // No stray ")" left dangling as separate trailing text
      expect(container.textContent).toBe(url);
    });

    it("still strips a genuinely unbalanced trailing paren used as sentence punctuation", () => {
      const fragment = renderMentions("(see https://example.com/page)");
      container.appendChild(fragment);

      const link = container.querySelector("a.msg-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute("href")).toBe("https://example.com/page");
      expect(container.textContent).toBe("(see https://example.com/page)");
    });
  });
});

// ─── Phase 6: display names and avatars on message rows ──────────────────────

describe("message row author identity", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("renders the display name from the member store, keeping the username as a title", () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "alice",
            displayName: "Alice A.",
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));

    const el = renderMessage(
      makeMessage({ user: { id: 10, username: "alice", avatar: null } }),
      false,
      [],
      makeOpts(),
      new AbortController().signal,
    );

    const author = el.querySelector(".msg-author");
    expect(author?.textContent).toBe("Alice A.");
    // The handle you would @mention is one hover away.
    expect(author?.getAttribute("title")).toBe("alice");
    // And the letter follows the rendered name.
    expect(el.querySelector(".msg-avatar .avatar-initial")?.textContent).toBe("A");
  });

  it("prefers the live member store over the identity frozen into the payload", () => {
    // A rename arrives as a user_update and patches the member store; the
    // messages already on screen still carry the old name in their payload.
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "renamed",
            displayName: null,
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));

    const el = renderMessage(
      makeMessage({ user: { id: 10, username: "old-name", avatar: null } }),
      false,
      [],
      makeOpts(),
      new AbortController().signal,
    );

    expect(el.querySelector(".msg-author")?.textContent).toBe("renamed");
  });

  it("falls back to the payload for an author who is not in the member list", () => {
    const el = renderMessage(
      makeMessage({
        user: { id: 99, username: "ghost", avatar: null, display_name: "Ghosty" },
      }),
      false,
      [],
      makeOpts(),
      new AbortController().signal,
    );

    expect(el.querySelector(".msg-author")?.textContent).toBe("Ghosty");
    expect(el.querySelector(".msg-avatar .avatar-initial")?.textContent).toBe("G");
  });
});

describe("userRoleColorVar", () => {
  it("uses the highest coloured held role, matching the member list", () => {
    setRoles([
      { id: 1, name: "Vip", color: null, permissions: 0, position: 30 },
      { id: 2, name: "Helper", color: "#2ecc71", permissions: 0, position: 20 },
      { id: 3, name: "Member", color: "#111111", permissions: 0, position: 10 },
    ]);
    membersStore.setState((p) => ({
      ...p,
      members: new Map([
        [
          9,
          {
            id: 9,
            username: "u",
            avatar: null,
            role: "vip",
            roleIds: [1, 3, 2],
            status: "online" as const,
          },
        ],
      ]),
    }));
    expect(userRoleColorVar(9)).toBe("#2ecc71");
  });
});
