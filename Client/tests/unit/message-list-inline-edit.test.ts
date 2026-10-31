/**
 * WP 3A-8: editing happens inside the message row. The list owns one lazy
 * editor session whose textarea node is re-hosted by every build of the row,
 * so a patch, a regroup or a scroll never costs the reader their text,
 * selection or focus.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore, type Message } from "@stores/messages.store";
import { loadEmojiCatalog } from "../../src/features/messaging/emojiCatalog";
import { clearCustomEmoji, emojiStore, setCustomEmoji } from "../../src/stores/emoji.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { resetMembersState, resetMessagesState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";
import { mountMessageInput } from "../helpers/messageInputHarness";

function seed(messages: readonly Message[]): void {
  resetMessagesState({ messagesByChannel: new Map([[1, [...messages]]]) });
}

/** Replace the stored messages as a store update would, then deliver it. */
function patch(id: number, change: Partial<Message>): void {
  const now = messagesStore.getState().messagesByChannel.get(1)!;
  seed(now.map((m) => (m.id === id ? { ...m, ...change } : m)));
  messagesStore.flush();
}

const mine = (id: number, over: Partial<Message> = {}): Message =>
  makeMessage({
    id,
    user: { id: ME, username: "me", avatar: null },
    content: `my message ${id}`,
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    ...over,
  });
const theirs = (id: number, over: Partial<Message> = {}): Message =>
  makeMessage({
    id,
    user: { id: OTHER, username: "alice", avatar: null },
    content: `their message ${id}`,
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    ...over,
  });

describe("inline message editor", () => {
  beforeAll(async () => {
    // Shortcodes only convert once the emoji catalog has loaded.
    await loadEmojiCatalog();
    clearCustomEmoji();
    setCustomEmoji([]);
    emojiStore.flush();
  });

  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;

  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`);
  const editor = (id: number): HTMLTextAreaElement | null =>
    container.querySelector<HTMLTextAreaElement>(`[data-testid='msg-edit-input-${id}']`);
  const byId = (testId: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`[data-testid='${testId}']`);

  function mount(messages: readonly Message[]): void {
    seed(messages);
    list = createMessageList(options);
    list.mount(container);
  }

  /** Open the editor on `id` and wait for the lazy chunk to land. */
  async function openEditor(id: number): Promise<HTMLTextAreaElement> {
    expect(list!.startEdit(id)).toBe(true);
    await vi.waitFor(() => expect(editor(id)).not.toBeNull());
    return editor(id)!;
  }

  function key(target: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel();
    resetMembersState();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeOpts({
      onEditClick: vi.fn((id: number) => {
        list?.startEdit(id);
      }),
      onEditEnd: vi.fn(),
    });
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    document.body.replaceChildren();
  });

  describe("opening", () => {
    it("the hover Edit button opens the editor in that row with the message text, caret at the end", async () => {
      mount([mine(1), mine(2)]);

      byId("msg-edit-2")!.click();
      await vi.waitFor(() => expect(editor(2)).not.toBeNull());

      const textarea = editor(2)!;
      expect(row(2)!.contains(textarea)).toBe(true);
      expect(row(2)!.classList.contains("editing")).toBe(true);
      expect(textarea.value).toBe("my message 2");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([12, 12]);
      expect(document.activeElement).toBe(textarea);
      // The other row is untouched.
      expect(editor(1)).toBeNull();
      expect(row(1)!.querySelector(".msg-text")?.textContent).toBe("my message 1");
    });

    it("the message menu's Edit Message opens the editor on the right row", async () => {
      mount([mine(1), mine(2)]);

      row(1)!
        .querySelector(".msg-text")!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
          }),
        );
      await vi.waitFor(() =>
        expect(document.querySelector(".message-context-menu")).not.toBeNull(),
      );
      const edit = [
        ...document.querySelectorAll<HTMLElement>(".message-context-menu [role=menuitem]"),
      ].find((el) => el.dataset["testid"] === "msg-menu-edit")!;
      edit.click();

      await vi.waitFor(() => expect(editor(1)).not.toBeNull());
      expect(editor(1)!.value).toBe("my message 1");
      expect(editor(2)).toBeNull();
    });

    it("ArrowUp on the empty composer opens the editor on your newest sent message", async () => {
      const messages = [
        mine(1),
        theirs(2),
        mine(3, { status: "pending", id: 0, correlationId: "c" }),
      ];
      mount(messages);
      const composerHost = document.createElement("div");
      document.body.appendChild(composerHost);
      const { comp: composer } = mountMessageInput(composerHost);
      // The controller's wiring: the newest own, sent message.
      composerHost.addEventListener("edit-last-message", () => {
        const newest = messages.findLast((m) => m.user.id === ME && m.status === "sent");
        if (newest !== undefined) list!.startEdit(newest.id);
      });

      composerHost
        .querySelector(".msg-textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

      await vi.waitFor(() => expect(editor(1)).not.toBeNull());
      expect(editor(1)!.value).toBe("my message 1");
      composer.destroy?.();
    });

    it("ArrowUp skips a call row that is your newest message and edits the one before", async () => {
      const call = mine(5, { kind: "call", content: "started a call." });
      const messages = [mine(1), call];
      mount(messages);
      const composerHost = document.createElement("div");
      document.body.appendChild(composerHost);
      const { comp: composer } = mountMessageInput(composerHost);
      // The controller's wiring (ChannelController's edit-last-message handler).
      composerHost.addEventListener("edit-last-message", () => {
        const newest = messages.findLast(
          (m) => m.user.id === ME && m.status === "sent" && m.kind === undefined,
        );
        if (newest !== undefined) list!.startEdit(newest.id);
      });
      composerHost
        .querySelector(".msg-textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await vi.waitFor(() => expect(editor(1)).not.toBeNull());
      expect(list!.startEdit(5)).toBe(false);
      composer.destroy?.();
    });

    it.each([
      ["a call log row", () => [mine(1, { kind: "call" })], 1],
      ["someone else's message", () => [theirs(1)], 1],
      ["an unsent message", () => [mine(0, { status: "pending", correlationId: "c" })], 0],
      ["a message that is not loaded", () => [mine(1)], 99],
    ])("refuses %s", (_name, messages, id) => {
      mount(messages());
      expect(list!.startEdit(id)).toBe(false);
      expect(list!.isEditing()).toBe(false);
    });

    it("opens with the given text instead of the stored one (a failed edit coming back)", async () => {
      mount([mine(1)]);
      expect(list!.startEdit(1, "the text that failed")).toBe(true);
      await vi.waitFor(() => expect(editor(1)).not.toBeNull());
      expect(editor(1)!.value).toBe("the text that failed");
    });

    it("opening a second edit cancels the first", async () => {
      mount([mine(1), mine(2)]);
      await openEditor(1);

      expect(list!.startEdit(2)).toBe(true);
      await vi.waitFor(() => expect(editor(2)).not.toBeNull());

      expect(editor(1)).toBeNull();
      expect(row(1)!.classList.contains("editing")).toBe(false);
      expect(row(1)!.querySelector(".msg-text")?.textContent).toBe("my message 1");
      expect(container.querySelectorAll(".msg-inline-edit")).toHaveLength(1);
    });

    it("starting the edit already open only focuses it", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "typed";
      textarea.blur();

      expect(list!.startEdit(1)).toBe(true);

      expect(editor(1)).toBe(textarea);
      expect(textarea.value).toBe("typed");
      expect(document.activeElement).toBe(textarea);
    });

    it("a row built while the chunk loads gets the editor once it arrives", async () => {
      mount([mine(1), mine(2)]);
      const before = row(2)!;

      expect(list!.startEdit(2)).toBe(true);
      // Before the lazy chunk lands, a reaction rebuilds the row.
      patch(2, { reactions: [{ emoji: "👍", count: 1, me: false }] });
      const rebuilt = row(2)!;
      expect(rebuilt).not.toBe(before);
      expect(editor(2)).toBeNull();

      await vi.waitFor(() => expect(editor(2)).not.toBeNull());
      expect(row(2)!.contains(editor(2))).toBe(true);
      expect(container.querySelectorAll(".msg-inline-edit")).toHaveLength(1);
      // Reactions stay under the editor.
      expect(row(2)!.querySelector(".reaction-chip")).not.toBeNull();
    });

    it("a channel switch (list destroy) discards the edit, and a load still in flight attaches nothing", async () => {
      mount([mine(1), mine(2)]);
      await openEditor(1);
      expect(list!.startEdit(2)).toBe(true);

      list!.destroy?.();

      expect(container.querySelector(".msg-inline-edit")).toBeNull();
      expect(list!.isEditing()).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector(".msg-inline-edit")).toBeNull();
      list = null;
    });
  });

  describe("the edited row", () => {
    it("has no hover action bar, no composer class and no (edited) tag", async () => {
      mount([mine(1, { editedAt: "2024-01-15T13:00:00Z" }), mine(2)]);
      expect(row(1)!.querySelector(".msg-edited")).not.toBeNull();
      expect(row(1)!.querySelector(".msg-actions-bar")).not.toBeNull();

      const textarea = await openEditor(1);

      expect(row(1)!.querySelector(".msg-actions-bar")).toBeNull();
      expect(row(1)!.querySelector(".msg-edited")).toBeNull();
      // GlobalKeybinds treats `.msg-textarea` as the composer; the editor is not.
      expect(textarea.classList.contains("msg-textarea")).toBe(false);
      expect(textarea.getAttribute("aria-label")).toBe("Edit message");
      // Other rows keep theirs.
      expect(row(2)!.querySelector(".msg-actions-bar")).not.toBeNull();
    });
  });

  describe("keys", () => {
    it("Enter saves through onEditSave with the typed text, and closes the editor", async () => {
      mount([mine(1), mine(2)]);
      const textarea = await openEditor(2);
      textarea.value = "  a better message  ";

      const e = key(textarea, "Enter");

      expect(e.defaultPrevented).toBe(true);
      expect(options.onEditSave).toHaveBeenCalledExactlyOnceWith(2, "a better message");
      expect(editor(2)).toBeNull();
      expect(list!.isEditing()).toBe(false);
      expect(row(2)!.classList.contains("editing")).toBe(false);
      // Focus went back to the host (the composer).
      expect(options.onEditEnd).toHaveBeenCalledTimes(1);
    });

    it("Shift+Enter is a newline: it saves nothing and is left to the browser", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);

      const e = key(textarea, "Enter", { shiftKey: true });

      expect(e.defaultPrevented).toBe(false);
      expect(options.onEditSave).not.toHaveBeenCalled();
      expect(editor(1)).not.toBeNull();
    });

    it.each([
      ["isComposing", { isComposing: true }],
      ["keyCode 229", { keyCode: 229 }],
    ])("Enter during an IME composition (%s) does nothing", async (_name, init) => {
      mount([mine(1)]);
      const textarea = await openEditor(1);

      const e = key(textarea, "Enter", init);

      expect(e.defaultPrevented).toBe(false);
      expect(options.onEditSave).not.toHaveBeenCalled();
      expect(editor(1)).not.toBeNull();
    });

    it.each([
      ["isComposing", { isComposing: true }],
      ["keyCode 229", { keyCode: 229 }],
    ])("Escape during an IME composition (%s) keeps the edit open", async (_name, init) => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "half composed";

      const e = key(textarea, "Escape", init);

      expect(e.defaultPrevented).toBe(false);
      expect(editor(1)).not.toBeNull();
      expect(textarea.value).toBe("half composed");
      expect(options.onEditEnd).not.toHaveBeenCalled();
    });

    it("Escape cancels, discarding the text, and is used up so the app-wide Escape leaves it", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "never mind";
      const appWide = vi.fn();
      document.addEventListener("keydown", appWide);

      const e = key(textarea, "Escape");

      expect(e.defaultPrevented).toBe(true);
      expect(editor(1)).toBeNull();
      expect(options.onEditSave).not.toHaveBeenCalled();
      expect(row(1)!.querySelector(".msg-text")?.textContent).toBe("my message 1");
      expect(options.onEditEnd).toHaveBeenCalledTimes(1);
      // The listener sees the event, but it arrives already prevented.
      expect(appWide.mock.calls[0]![0].defaultPrevented).toBe(true);
      document.removeEventListener("keydown", appWide);
    });

    it("Ctrl+B wraps the selection in ** and keeps the key from the global shortcuts", async () => {
      mount([mine(1, { content: "make bold please" })]);
      const textarea = await openEditor(1);
      textarea.setSelectionRange(5, 9);
      const global = vi.fn();
      document.addEventListener("keydown", global);

      const e = key(textarea, "b", { ctrlKey: true });

      expect(e.defaultPrevented).toBe(true);
      expect(textarea.value).toBe("make **bold** please");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 11]);
      expect(global).not.toHaveBeenCalled();
      document.removeEventListener("keydown", global);
    });
  });

  describe("the Save and Cancel links", () => {
    it("Save saves the text", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "via the link";

      byId("msg-edit-save-1")!.click();

      expect(options.onEditSave).toHaveBeenCalledExactlyOnceWith(1, "via the link");
      expect(editor(1)).toBeNull();
    });

    it("Cancel closes the editor without saving", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "discard me";

      byId("msg-edit-cancel-1")!.click();

      expect(options.onEditSave).not.toHaveBeenCalled();
      expect(editor(1)).toBeNull();
      // The link held focus, so the host gets it back.
      expect(options.onEditEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("saving", () => {
    it("an emptied editor calls onEmptyEdit, saves nothing and stays open", async () => {
      mount([mine(1), mine(2)]);
      const textarea = await openEditor(2);
      textarea.value = "   ";

      key(textarea, "Enter");

      expect(options.onEmptyEdit).toHaveBeenCalledExactlyOnceWith(2);
      expect(options.onEditSave).not.toHaveBeenCalled();
      // Cancel on the delete confirm leaves the edit as it was.
      expect(editor(2)).toBe(textarea);
      expect(list!.isEditing()).toBe(true);
    });

    it("the delete confirm closing the edit is the host's cancelEdit", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "";
      key(textarea, "Enter");

      list!.cancelEdit();

      expect(editor(1)).toBeNull();
      expect(list!.isEditing()).toBe(false);
    });

    it("unchanged text is handed to onEditSave (which sends nothing) and the editor closes", async () => {
      vi.mocked(options.onEditSave).mockReturnValue(true);
      mount([mine(1)]);
      const textarea = await openEditor(1);

      key(textarea, "Enter");

      expect(options.onEditSave).toHaveBeenCalledExactlyOnceWith(1, "my message 1");
      expect(editor(1)).toBeNull();
    });

    it("turns a typed :joy: into the emoji on save", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "so funny :joy:";

      key(textarea, "Enter");

      expect(options.onEditSave).toHaveBeenCalledExactlyOnceWith(1, "so funny 😂");
    });

    it("refuses text past 4000 code points with an inline error and stays open", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "a".repeat(4001);

      key(textarea, "Enter");

      expect(options.onEditSave).not.toHaveBeenCalled();
      expect(editor(1)).toBe(textarea);
      const error = row(1)!.querySelector<HTMLElement>(".msg-inline-edit-error")!;
      expect(error.hidden).toBe(false);
      expect(error.getAttribute("role")).toBe("alert");
      expect(error.textContent).toContain("4000");
      // The field is tied to the message while it shows.
      expect(error.id).not.toBe("");
      expect(textarea.getAttribute("aria-invalid")).toBe("true");
      expect(textarea.getAttribute("aria-describedby")).toBe(error.id);
      // Typing again clears it, and the field's error state with it.
      textarea.value = "a".repeat(10);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      expect(error.hidden).toBe(true);
      expect(textarea.hasAttribute("aria-invalid")).toBe(false);
      expect(textarea.hasAttribute("aria-describedby")).toBe(false);
    });

    it("counts astral characters as one code point each", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "😀".repeat(4000);

      key(textarea, "Enter");

      expect(options.onEditSave).toHaveBeenCalledTimes(1);
    });

    it("onEditSave returning false (offline) keeps the editor open with the text", async () => {
      vi.mocked(options.onEditSave).mockReturnValue(false);
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "offline edit";

      key(textarea, "Enter");

      expect(options.onEditSave).toHaveBeenCalledExactlyOnceWith(1, "offline edit");
      expect(editor(1)).toBe(textarea);
      expect(textarea.value).toBe("offline edit");
      expect(list!.isEditing()).toBe(true);
      expect(options.onEditEnd).not.toHaveBeenCalled();
    });
  });

  describe("the composer", () => {
    it("keeps its draft and reply through an edit, a save and a cancel", async () => {
      mount([mine(1), mine(2)]);
      const composerHost = document.createElement("div");
      document.body.appendChild(composerHost);
      const { comp: composer } = mountMessageInput(composerHost);
      const draft = composerHost.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
      draft.value = "half a thought";
      composer.setReplyTo(7, "alice");
      const draftBefore = composer.peekDraft();
      const replyBar = composerHost.querySelector(".reply-bar")!;
      expect(replyBar.classList.contains("visible")).toBe(true);

      // Edit and save.
      const textarea = await openEditor(1);
      textarea.value = "edited";
      expect(draft.value).toBe("half a thought");
      expect(replyBar.classList.contains("visible")).toBe(true);
      key(textarea, "Enter");
      expect(draft.value).toBe("half a thought");
      expect(composer.peekDraft()).toEqual(draftBefore);

      // Edit and cancel.
      const second = await openEditor(2);
      second.value = "changed my mind";
      key(second, "Escape");
      expect(draft.value).toBe("half a thought");
      expect(composer.peekDraft()).toEqual(draftBefore);
      expect(replyBar.classList.contains("visible")).toBe(true);
      composer.destroy?.();
    });
  });

  // Edge case 1 of the design note.
  describe("a rebuild while you type", () => {
    it("reaction_update while editing keeps value, selection and focus", async () => {
      mount([mine(1), mine(2), mine(3)]);
      const textarea = await openEditor(2);
      textarea.value = "a long half-typed edit";
      textarea.focus();
      textarea.setSelectionRange(2, 6);
      const rowBefore = row(2)!;

      patch(2, { reactions: [{ emoji: "🔥", count: 2, me: false }] });

      // The row was drawn again around the same textarea node.
      expect(row(2)).not.toBe(rowBefore);
      expect(editor(2)).toBe(textarea);
      expect(row(2)!.contains(textarea)).toBe(true);
      expect(row(2)!.querySelector(".reaction-chip")).not.toBeNull();
      expect(textarea.value).toBe("a long half-typed edit");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 6]);
      expect(document.activeElement).toBe(textarea);
      expect(container.querySelectorAll(".msg-inline-edit")).toHaveLength(1);
    });

    it("someone else's edit echo for the message keeps the editor and the typed text", async () => {
      mount([mine(1)]);
      const textarea = await openEditor(1);
      textarea.value = "mine, typing";
      textarea.focus();

      patch(1, { content: "edited elsewhere", editedAt: "2024-01-15T13:00:00Z" });

      expect(editor(1)).toBe(textarea);
      expect(textarea.value).toBe("mine, typing");
      expect(document.activeElement).toBe(textarea);
      expect(row(1)!.querySelector(".msg-text")).toBeNull();
    });
  });

  it("the editor closes silently when its message leaves the list, without the host's focus hand-off if it never had focus", async () => {
    mount([mine(1), mine(2)]);
    const textarea = await openEditor(2);
    textarea.blur();

    patch(2, { deleted: true });

    expect(editor(2)).toBeNull();
    expect(list!.isEditing()).toBe(false);
    expect(options.onEditEnd).not.toHaveBeenCalled();
  });

  it("a reply without referencedMessage reads 'deleted', not unknown, once its loaded parent is deleted live", () => {
    mount([mine(1), mine(2, { replyTo: 1, referencedMessage: undefined })]);
    expect(row(2)!.querySelector(".msg-reply-ref[role='button']")).not.toBeNull();

    patch(1, { deleted: true });

    expect(row(1)).toBeNull();
    const ref = row(2)!.querySelector<HTMLElement>(".msg-reply-ref")!;
    expect(ref.classList.contains("msg-reply-ref--deleted")).toBe(true);
    expect(ref.textContent).toBe("Original message was deleted");
    expect(ref.getAttribute("role")).toBeNull();
    expect(ref.getAttribute("tabindex")).toBeNull();
  });
});
