/**
 * renderMessage's variants, asserted on the concrete DOM: which parts a row
 * has for each kind of message, so the function can be split without changing
 * what it draws.
 */
import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/renderersMocks";
import { renderMessage } from "../../../src/components/message-list/renderers";
import { upsertThread, resetThreadsStore } from "../../../src/stores/threads.store";
import { makeThread } from "../../helpers/thread-fixtures";
import {
  makeMessage,
  makeOpts,
  useRenderersHarness,
  mountMessage,
} from "../../helpers/renderersHarness";
import type { Message } from "../../../src/stores/messages.store";
import type { MessageRenderOptions } from "../../../src/components/message-list/renderers";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../../src/platform/desktop/externalContent", () => mocks.desktopExternalContentMock());

const REACTIONS = [{ emoji: "👍", count: 2, me: false }];
const FILE = {
  id: "1",
  filename: "doc.pdf",
  size: 2048,
  mime: "application/pdf",
  url: "/uploads/doc.pdf",
};

describe("renderMessage variants", () => {
  let container: HTMLDivElement;
  useRenderersHarness((el) => {
    container = el;
  });

  const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel);

  function mountReply(
    reply: Partial<Message>,
    loaded: readonly Message[] = [],
    optOverrides: Partial<MessageRenderOptions> = {},
  ): { ref: HTMLElement; ac: AbortController; opts: MessageRenderOptions } {
    const msg = makeMessage({ id: 5, replyTo: 4, ...reply });
    const opts = makeOpts(optOverrides);
    const ac = new AbortController();
    container.appendChild(renderMessage(msg, false, [...loaded, msg], opts, ac.signal));
    return { ref: q(".msg-reply-ref")!, ac, opts };
  }

  describe("row shape", () => {
    it("an ungrouped row has a header with author, time and avatar but no hover time", () => {
      const { el, ac } = mountMessage(container, makeMessage({ id: 7 }));
      expect(el.className).toBe("message");
      expect(el.dataset["testid"]).toBe("message-7");
      expect(el.querySelector(".msg-avatar")?.getAttribute("data-user-id")).toBe("10");
      expect(el.querySelector(".msg-author")?.textContent).toBe("Alice");
      expect(el.querySelector(".msg-author")?.getAttribute("role")).toBe("button");
      expect(el.querySelector(".msg-header .msg-time")).not.toBeNull();
      expect(el.querySelector(".msg-header .msg-compact-time")).not.toBeNull();
      expect(el.querySelector(".msg-hover-time")).toBeNull();
      expect(el.querySelector(".msg-text")?.textContent).toBe("Hello world");
      ac.abort();
    });

    it("a grouped row adds the hover time and keeps the header", () => {
      const msg = makeMessage({ id: 8 });
      const ac = new AbortController();
      const el = renderMessage(msg, true, [msg], makeOpts(), ac.signal);
      expect(el.className).toBe("message grouped");
      expect(el.querySelector(".msg-hover-time")?.getAttribute("title")).toBeTruthy();
      expect(el.querySelector(".msg-header")).not.toBeNull();
      ac.abort();
    });

    it("an editor replaces the body, marks the row editing and keeps attachments, reactions and no action bar", () => {
      const msg = makeMessage({ attachments: [FILE], reactions: REACTIONS });
      const editor = document.createElement("div");
      editor.className = "inline-editor";
      const ac = new AbortController();
      const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal, editor);
      expect(el.className).toBe("message editing");
      expect(el.querySelector(".inline-editor")).toBe(editor);
      expect(el.querySelector(".msg-text")).toBeNull();
      expect(el.querySelector(".msg-file")).not.toBeNull();
      expect(el.querySelector(".reaction-chip")).not.toBeNull();
      expect(el.querySelector(".msg-actions-bar")).toBeNull();
      ac.abort();
    });
  });

  describe("author kinds", () => {
    it("an imported author gets an imported name and tag, a letter avatar and no user id", () => {
      const msg = makeMessage({
        importedAuthor: { name: "Zed", color: "#336699" },
      });
      const { el, ac } = mountMessage(container, msg);
      const name = el.querySelector<HTMLElement>(".msg-author--imported")!;
      expect(name.textContent).toBe("Zed");
      expect(name.dataset["roleColor"]).toBe("#336699");
      expect(name.getAttribute("role")).toBeNull();
      expect(el.querySelector(".msg-header .imported-tag")).not.toBeNull();
      expect(el.querySelector(".msg-avatar")?.hasAttribute("data-user-id")).toBe(false);
      expect(el.dataset["authorKey"]).toBeTruthy();
      ac.abort();
    });

    it("an account author's row is keyed by its identity, not an imported one", () => {
      const { el, ac } = mountMessage(container, makeMessage());
      expect(el.dataset["authorKey"]).toBeTruthy();
      expect(el.querySelector(".imported-tag")).toBeNull();
      expect(el.querySelector(".msg-author")?.getAttribute("data-role-color")).toBeTruthy();
      ac.abort();
    });

    it("a server system row has no author, header or action bar", () => {
      const msg = makeMessage({ user: { id: 0, username: "System", avatar: null } });
      const { el, ac } = mountMessage(container, msg);
      expect(el.classList.contains("system-msg")).toBe(true);
      expect(el.querySelector(".msg-author")).toBeNull();
      expect(el.querySelector(".msg-actions-bar")).toBeNull();
      ac.abort();
    });

    it("an unknown server row kind falls back to system text with the message test id", () => {
      const msg = makeMessage({ id: 9, kind: "future_kind" });
      const { el, ac } = mountMessage(container, msg);
      expect(el.classList.contains("system-msg")).toBe(true);
      expect(el.dataset["testid"]).toBe("message-9");
      ac.abort();
    });
  });

  describe("deleted and edited", () => {
    it("a deleted row shows the muted italic notice, no action bar, edit mark or reactions", () => {
      const msg = makeMessage({
        deleted: true,
        editedAt: "2025-01-16T00:00:00Z",
        reactions: REACTIONS,
      });
      const { el, ac } = mountMessage(container, msg);
      const text = el.querySelector<HTMLElement>(".msg-text")!;
      expect(text.style.fontStyle).toBe("italic");
      expect(text.textContent).toBe("[message deleted]");
      expect(el.querySelector(".msg-edited")).toBeNull();
      expect(el.querySelector(".reaction-chip")).toBeNull();
      expect(el.querySelector(".msg-actions-bar")).toBeNull();
      expect(el.classList.contains("mentioned")).toBe(false);
      ac.abort();
    });

    it("an edited row carries the marker with the edit time as its title", () => {
      const { el, ac } = mountMessage(container, makeMessage({ editedAt: "2025-01-16T08:00:00Z" }));
      const mark = el.querySelector<HTMLElement>(".msg-edited")!;
      expect(mark.textContent).toBe("(edited)");
      expect(mark.title).not.toBe("");
      ac.abort();
    });

    it("an unedited row has no marker", () => {
      const { el, ac } = mountMessage(container, makeMessage());
      expect(el.querySelector(".msg-edited")).toBeNull();
      ac.abort();
    });
  });

  describe("attachments, reactions and thread chip", () => {
    it("shows each part when present, in order: text, file, chip, reactions, actions", () => {
      resetThreadsStore();
      upsertThread(makeThread({ starter_message_id: 1 }));
      const msg = makeMessage({ attachments: [FILE], reactions: REACTIONS });
      const { el, ac } = mountMessage(container, msg);
      const order = [
        ".msg-text",
        ".msg-file",
        ".msg-thread-chip",
        ".reaction-chip",
        ".msg-actions-bar",
      ].map((sel) => {
        const part = el.querySelector(sel);
        expect(part, sel).not.toBeNull();
        return [...el.children].findIndex((c) => c === part || c.contains(part));
      });
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(el.querySelector(".msg-thread-chip")?.getAttribute("data-thread-id")).toBe("91");
      ac.abort();
      resetThreadsStore();
    });

    it("leaves each part out when absent", () => {
      resetThreadsStore();
      const { el, ac } = mountMessage(container, makeMessage());
      expect(el.querySelector(".msg-file")).toBeNull();
      expect(el.querySelector(".msg-thread-chip")).toBeNull();
      expect(el.querySelector(".reaction-chip")).toBeNull();
      ac.abort();
    });

    it("a thread chip opens its thread through onOpenThread", () => {
      resetThreadsStore();
      upsertThread(makeThread({ starter_message_id: 1 }));
      const onOpenThread = vi.fn();
      const { el, ac } = mountMessage(container, makeMessage(), makeOpts({ onOpenThread }));
      el.querySelector<HTMLElement>(".msg-thread-chip")!.click();
      expect(onOpenThread).toHaveBeenCalledWith(91);
      ac.abort();
      resetThreadsStore();
    });
  });

  describe("reply reference", () => {
    const parent = makeMessage({ id: 4, content: "parent **text**" });

    it("a loaded parent shows its author and plain text", () => {
      const { ref, ac } = mountReply({}, [parent]);
      expect(ref.getAttribute("role")).toBe("button");
      expect(ref.dataset["replyTo"]).toBe("4");
      expect(ref.dataset["authorKey"]).toBeTruthy();
      expect(ref.querySelector(".rr-author")?.textContent).toBe("Alice");
      expect(ref.querySelector(".rr-text")?.textContent).toBe("parent text");
      ac.abort();
    });

    it("reports the jump to the host for a click and for Enter or Space, not other keys", () => {
      const onJumpToMessage = vi.fn();
      const { ref, ac } = mountReply({}, [parent], { onJumpToMessage });
      ref.click();
      ref.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      ref.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      ref.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(onJumpToMessage).toHaveBeenCalledTimes(3);
      expect(onJumpToMessage).toHaveBeenCalledWith(4);
      ac.abort();
    });

    it("a loaded parent with only an attachment shows the attachment placeholder", () => {
      const { ref, ac } = mountReply({}, [
        makeMessage({ id: 4, content: "", attachments: [FILE] }),
      ]);
      expect(ref.querySelector(".rr-text")?.textContent).toBe("Attachment");
      ac.abort();
    });

    it("a loaded imported parent shows the imported name and tag", () => {
      const imported = makeMessage({
        id: 4,
        importedAuthor: { name: "Zed" },
      });
      const { ref, ac } = mountReply({}, [imported]);
      expect(ref.querySelector(".rr-author")?.textContent).toBe("Zed");
      expect(ref.querySelector(".imported-tag")).not.toBeNull();
      expect(ref.querySelector(".rr-text")?.textContent).toBe("Hello world");
      ac.abort();
    });

    it("a deleted loaded parent is plain text with no jump", () => {
      const onJumpToMessage = vi.fn();
      const { ref, ac } = mountReply({}, [makeMessage({ id: 4, deleted: true })], {
        onJumpToMessage,
      });
      expect(ref.className).toBe("msg-reply-ref msg-reply-ref--deleted");
      expect(ref.getAttribute("role")).toBeNull();
      expect(ref.textContent).toBe("Original message was deleted");
      ref.click();
      expect(onJumpToMessage).not.toHaveBeenCalled();
      ac.abort();
    });

    it("a missing parent with no snippet reads as unknown and still jumps", () => {
      const onJumpToMessage = vi.fn();
      const { ref, ac } = mountReply({}, [], { onJumpToMessage });
      expect(ref.textContent).toBe("Reply to unknown message");
      ref.click();
      expect(onJumpToMessage).toHaveBeenCalledWith(4);
      ac.abort();
    });

    it("a blocked loaded parent shows the blocked notice instead of its text", () => {
      const { ref, ac } = mountReply({}, [parent], { blockedUsers: new Set([10]) });
      expect(ref.classList.contains("msg-reply-ref--blocked")).toBe(true);
      expect(ref.textContent).toBe("Blocked message");
      expect(ref.querySelector(".rr-text")).toBeNull();
      ac.abort();
    });

    it("a blocked author seen only through the server snippet is hidden too", () => {
      const { ref, ac } = mountReply(
        {
          referencedMessage: {
            id: 4,
            user: { id: 10, username: "alice", avatar: null },
            content: "secret",
            deleted: false,
            has_attachments: false,
          },
        },
        [],
        { blockedUsers: new Set([10]) },
      );
      expect(ref.classList.contains("msg-reply-ref--blocked")).toBe(true);
      expect(ref.textContent).not.toContain("secret");
      ac.abort();
    });

    it("an imported snippet shows the imported name, tag and snippet text", () => {
      const { ref, ac } = mountReply({
        referencedMessage: {
          id: 4,
          user: { id: 10, username: "hidden", avatar: null },
          content: "old *words*",
          deleted: false,
          has_attachments: false,
          imported_author: { name: "Zed" },
        },
      });
      expect(ref.querySelector(".rr-author")?.textContent).toBe("Zed");
      expect(ref.querySelector(".imported-tag")).not.toBeNull();
      expect(ref.querySelector(".rr-text")?.textContent).toBe("old words");
      ac.abort();
    });

    it("an empty snippet shows the attachment placeholder", () => {
      const { ref, ac } = mountReply({
        referencedMessage: {
          id: 4,
          user: { id: 10, username: "alice", avatar: null },
          content: "",
          deleted: false,
          has_attachments: true,
        },
      });
      expect(ref.querySelector(".rr-text")?.textContent).toBe("Attachment");
      ac.abort();
    });
  });
});
