/**
 * WP 6.12: the "pinned a message" row. Drawn from `kind` + `replyTo` alone
 * (never `content`), with a jump link while the target lives, plain text once
 * it is deleted or purged, and a link that opens the pins panel. Delete follows
 * the ordinary message rule; nothing else is offered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { createMessageList } from "@components/MessageList";
import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/message-actions";
import { pinRowTarget } from "@components/message-list/pinRows";
import { shouldGroup } from "@lib/text/formatting";
import { isPinRowKind, isServerRowKind } from "@lib/text/messageKind";
import {
  bulkDeleteMessages,
  deleteMessage,
  messagesStore,
  type Message,
} from "@stores/messages.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  setDeveloperMode,
  signInAs,
} from "../helpers/message-actions-fixtures";

function pinRow(over: Partial<Message> = {}): Message {
  return makeMessage({
    id: 9,
    kind: "pin_add",
    content: "English fallback that must never be shown",
    replyTo: 4,
    referencedMessage: null,
    ...over,
  });
}

function render(
  msg: Message,
  opts = makeOpts({ onJumpToMessage: vi.fn(), onOpenPins: vi.fn() }),
): HTMLElement {
  return renderMessage(msg, false, [msg], opts, new AbortController().signal);
}
const textOf = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("isPinRowKind", () => {
  it("is true only for pin_add, which is still a server row", () => {
    expect(isPinRowKind("pin_add")).toBe(true);
    expect(isPinRowKind("call")).toBe(false);
    expect(isPinRowKind("group_add")).toBe(false);
    expect(isPinRowKind(undefined)).toBe(false);
    expect(isServerRowKind("pin_add")).toBe(true);
  });
});

describe("pinRowTarget", () => {
  it("is the reply id while the target lives, else null", () => {
    expect(pinRowTarget(pinRow())).toBe(4);
    expect(pinRowTarget(pinRow({ replyTo: null }))).toBeNull();
    const deleted = { id: 4, user: null, content: "", deleted: true, has_attachments: false };
    expect(pinRowTarget(pinRow({ referencedMessage: deleted }))).toBeNull();
    expect(pinRowTarget(pinRow({ referencedMessage: { ...deleted, deleted: false } }))).toBe(4);
  });
});

describe("pin row rendering", () => {
  it("draws the sentence with a live target, from kind alone", () => {
    const el = render(pinRow());
    expect(el.classList.contains("pin-row")).toBe(true);
    expect(el.dataset["testid"]).toBe("message-9");
    expect(textOf(el)).toContain(
      "alice pinned a message to this channel. See all pinned messages.",
    );
    expect(textOf(el)).not.toContain("English fallback");
    expect(el.querySelector('[data-testid="pin-row-message-9"]')?.tagName).toBe("BUTTON");
    expect(el.querySelector('[data-testid="pin-row-pins-9"]')?.tagName).toBe("BUTTON");
  });

  it("says You for the viewer's own pin", () => {
    const el = render(pinRow({ user: { id: ME, username: "me", avatar: null } }));
    expect(textOf(el)).toContain("You pinned a message to this channel.");
  });

  it("keeps the links in place when the name carries a marker character", () => {
    const el = render(pinRow({ user: { id: OTHER, username: "x\uE000y\uE001z", avatar: null } }));
    expect(textOf(el)).toContain("xyz pinned a message to this channel. See all pinned messages.");
    expect(el.querySelectorAll("button")).toHaveLength(2);
  });

  it("draws the same wording in a DM", () => {
    const opts = makeOpts({ channelType: "dm" });
    expect(textOf(render(pinRow(), opts))).toContain("alice pinned a message to this channel.");
  });

  it("makes 'a message' plain text when the target is deleted", () => {
    const deleted = { id: 4, user: null, content: "", deleted: true, has_attachments: false };
    const el = render(
      pinRow({ referencedMessage: deleted }),
      makeOpts({ onJumpToMessage: vi.fn(), onOpenPins: vi.fn() }),
    );
    expect(el.querySelector('[data-testid="pin-row-message-9"]')).toBeNull();
    expect(textOf(el)).toContain("alice pinned a message to this channel.");
    // The pins link is independent of the target.
    expect(el.querySelector('[data-testid="pin-row-pins-9"]')).not.toBeNull();
  });

  it("makes 'a message' plain text when the target was purged (replyTo null)", () => {
    const el = render(pinRow({ replyTo: null }));
    expect(el.querySelector('[data-testid="pin-row-message-9"]')).toBeNull();
    expect(textOf(el)).toContain("a message");
  });

  it("has no links when the list wires neither callback", () => {
    const opts = makeOpts();
    delete (opts as { onJumpToMessage?: unknown }).onJumpToMessage;
    const el = render(pinRow(), opts);
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(textOf(el)).toContain("See all pinned messages.");
  });

  it("jumps to the pinned message and opens the pins panel on click", () => {
    const onJumpToMessage = vi.fn();
    const onOpenPins = vi.fn();
    const el = render(pinRow(), makeOpts({ onJumpToMessage, onOpenPins }));
    el.querySelector<HTMLButtonElement>('[data-testid="pin-row-message-9"]')!.click();
    expect(onJumpToMessage).toHaveBeenCalledExactlyOnceWith(4);
    expect(onOpenPins).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('[data-testid="pin-row-pins-9"]')!.click();
    expect(onOpenPins).toHaveBeenCalledOnce();
    expect(onJumpToMessage).toHaveBeenCalledOnce();
  });

  it("never groups with a neighbour", () => {
    const row = pinRow();
    const prev = makeMessage({ id: 3, timestamp: "2024-01-15T11:59:55Z" });
    const next = makeMessage({ id: 10, timestamp: "2024-01-15T12:00:05Z" });
    expect(shouldGroup(prev, row)).toBe(false);
    expect(shouldGroup(row, next)).toBe(false);
  });
});

const liveRow = (): Message => pinRow({ replyTo: 4, referencedMessage: null });
const seed = (rows: Message[]): void => {
  messagesStore.setState(() => ({
    messagesByChannel: new Map([[1, rows]]),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
};
const rowNow = (): Message =>
  messagesStore
    .getState()
    .messagesByChannel.get(1)!
    .find((m) => m.id === 9)!;

describe("a live pin row whose target goes away", () => {
  it("stops jumping once the target is deleted", () => {
    seed([makeMessage({ id: 4 }), liveRow()]);
    expect(pinRowTarget(rowNow())).toBe(4);
    deleteMessage({ channel_id: 1, message_id: 4 });
    expect(pinRowTarget(rowNow())).toBeNull();
    expect(render(rowNow()).querySelector('[data-testid="pin-row-message-9"]')).toBeNull();
  });

  it("stops jumping once the target is purged, and other deletes leave it alone", () => {
    seed([liveRow()]);
    bulkDeleteMessages({ channel_id: 1, ids: [7] });
    expect(pinRowTarget(rowNow())).toBe(4);
    bulkDeleteMessages({ channel_id: 1, ids: [7, 4] });
    expect(pinRowTarget(rowNow())).toBeNull();
  });
});

describe("pin row actions", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | undefined;

  beforeEach(() => {
    resetGateStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    list?.destroy?.();
    list = undefined;
    container.remove();
    document.querySelectorAll(".context-menu, .message-context-menu").forEach((el) => el.remove());
    setDeveloperMode(false);
    resetGateStores();
  });

  const shown = (g: ReturnType<typeof messageActionGates>): boolean[] =>
    [g.react, g.edit, g.pin, g.delete, g.report].map((x) => x.shown);

  it("channel: the author may delete; nothing else is offered", () => {
    signInAs("member");
    setChannel({ type: "text" });
    const own = pinRow({ user: { id: ME, username: "me", avatar: null } });
    expect(shown(messageActionGates(own, makeOpts({ onReportClick: vi.fn() })))).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it("channel: a plain member cannot delete another member's pin row", () => {
    signInAs("member");
    setChannel({ type: "text", canDeleteOthers: false });
    expect(shown(messageActionGates(pinRow(), makeOpts()))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("channel: MANAGE_MESSAGES may delete another member's pin row", () => {
    signInAs("moderator");
    setChannel({ type: "text", canDeleteOthers: true });
    expect(messageActionGates(pinRow(), makeOpts()).delete.shown).toBe(true);
  });

  it("DM: only the author may delete", () => {
    signInAs("moderator");
    setChannel({ type: "dm" });
    const dm = makeOpts({ channelType: "dm" });
    expect(messageActionGates(pinRow(), dm).delete.shown).toBe(false);
    const own = pinRow({ user: { id: ME, username: "me", avatar: null } });
    expect(messageActionGates(own, dm).delete.shown).toBe(true);
  });

  it("call and group rows stay undeletable", () => {
    signInAs("moderator");
    setChannel({ type: "text", canDeleteOthers: true });
    for (const kind of ["call", "group_add", "group_future"]) {
      const row = makeMessage({ kind, user: { id: ME, username: "me", avatar: null } });
      expect(messageActionGates(row, makeOpts()).delete.shown).toBe(false);
    }
  });

  it("a deleted or unsent pin row offers nothing", () => {
    signInAs("moderator");
    setChannel({ type: "text", canDeleteOthers: true });
    expect(messageActionGates(pinRow({ deleted: true }), makeOpts()).delete.shown).toBe(false);
    expect(messageActionGates(pinRow({ status: "pending" }), makeOpts()).delete.shown).toBe(false);
  });

  it("the right-click menu offers only Delete, and it deletes", async () => {
    signInAs("member");
    setChannel({ type: "text" });
    const row = pinRow({ user: { id: ME, username: "me", avatar: null } });
    messagesStore.setState(() => ({
      messagesByChannel: new Map([[1, [row]]]),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    const onDeleteClick = vi.fn();
    list = createMessageList(makeOpts({ onDeleteClick }));
    list.mount(container);
    const el = container.querySelector<HTMLElement>('[data-testid="message-9"]')!;
    expect(el.querySelector(".msg-actions-bar")).toBeNull();
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    await vi.waitFor(() => expect(document.querySelector(".message-context-menu")).not.toBeNull());
    const names = [
      ...document.querySelectorAll<HTMLElement>('.message-context-menu [role="menuitem"]'),
    ].map((i) => i.getAttribute("aria-label") ?? i.textContent ?? "");
    expect(names).toEqual(["Delete Message"]);
    document
      .querySelector<HTMLElement>('.message-context-menu [data-testid="msg-menu-delete"]')!
      .click();
    expect(onDeleteClick).toHaveBeenCalledWith(9, false);
  });

  it("no menu for another member's pin row without delete rights", async () => {
    signInAs("member");
    setChannel({ type: "text", canDeleteOthers: false });
    messagesStore.setState(() => ({
      messagesByChannel: new Map([
        [1, [pinRow({ user: { id: OTHER, username: "a", avatar: null } })]],
      ]),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    list = createMessageList(makeOpts());
    list.mount(container);
    container
      .querySelector<HTMLElement>('[data-testid="message-9"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await import("@components/message-list/message-menu");
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".message-context-menu")).toBeNull();
  });
});
