import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import {
  bindImageMenu,
  closeActiveLightbox,
} from "../../src/features/messaging/content/attachments";
import type { Message } from "@stores/messages.store";
import { setConnectionStatus } from "@stores/ui.store";
import { setActiveTimeout } from "../../src/features/safety/store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  setDeveloperMode,
  signInAs,
  seedMessages as seed,
} from "../helpers/message-actions-fixtures";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

const MENU = ".message-context-menu";

function mine(over: Partial<Message> = {}): Message {
  return makeMessage({ user: { id: ME, username: "me", avatar: null }, ...over });
}

function rightClick(target: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

const menu = (): HTMLElement | null => document.querySelector<HTMLElement>(MENU);
const sheet = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="message-sheet"]');

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`${MENU} [role="menuitem"]`)];
}
const nameOf = (el: HTMLElement): string => el.getAttribute("aria-label") ?? el.textContent ?? "";
const names = (): string[] => items().map(nameOf);
// Matched by property, not selector: the emoji ids hold astral characters.
const item = (testId: string): HTMLElement | null =>
  items().find((el) => el.dataset["testid"] === testId) ?? null;

/** Let the lazy `import()` and any microtasks land, so "no menu" is not vacuous. */
async function settled(): Promise<void> {
  await import("@components/message-list/messageMenu");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function open(target: Element, init?: MouseEventInit): Promise<void> {
  rightClick(target, init);
  await vi.waitFor(() => expect(menu()).not.toBeNull());
}

describe("message right-click menu", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;
  let opts: MessageListOptions;
  let writeText: ReturnType<typeof vi.fn>;

  function mount(messages: Message[], over: Partial<MessageListOptions> = {}): void {
    seed(messages);
    opts = makeOpts(over);
    list = createMessageList(opts);
    list.mount(container);
  }
  const row = (id = 1): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="message-${id}"]`)!;
  const text = (id = 1): HTMLElement => row(id).querySelector<HTMLElement>(".msg-text")!;

  beforeEach(() => {
    resetGateStores();
    localStorage.clear();
    signInAs("member");
    setChannel();
    resetMembersState();
    container = document.createElement("div");
    document.body.appendChild(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    list?.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    setDeveloperMode(false);
    resetGateStores();
  });

  it("own message, manager, channel: exact item order", async () => {
    signInAs("moderator");
    mount([mine()], { onReportClick: vi.fn() });
    await open(text());
    expect(menu()?.getAttribute("role")).toBe("menu");
    expect(menu()?.getAttribute("aria-label")).toBe("Message actions");
    expect(names()).toEqual([
      "React with \u{1F44D}",
      "React with ❤️",
      "React with \u{1F602}",
      "Add Reaction",
      "Edit Message",
      "Reply",
      "Copy Text",
      "Pin Message",
      "Copy Message Link",
      "Delete Message",
    ]);
    // The quick emoji share one group row.
    expect(menu()?.querySelectorAll('[role="group"] [role="menuitem"]').length).toBe(3);
  });

  it("developer mode adds Copy Message ID last, which copies the id", async () => {
    setDeveloperMode(true);
    mount([makeMessage({ id: 77 })]);
    await open(text(77));
    expect(names().at(-1)).toBe("Copy Message ID");
    item("msg-menu-copy-id")!.click();
    expect(writeText).toHaveBeenCalledWith("77");
  });

  it("other user's message: Report, no Edit", async () => {
    const onReportClick = vi.fn();
    mount([makeMessage()], { onReportClick });
    await open(text());
    expect(names()).toContain("Report Message");
    expect(names()).not.toContain("Edit Message");
    item("msg-menu-report")!.click();
    expect(onReportClick).toHaveBeenCalledWith(1);
  });

  it("DM: no Delete on the other participant's message, Pin is offered", async () => {
    signInAs("moderator");
    setChannel({ canDeleteOthers: true });
    mount([makeMessage()], { channelType: "dm" });
    await open(text());
    expect(names()).not.toContain("Delete Message");
    expect(names()).toContain("Pin Message");
  });

  it("canPin / canDeleteOthers bits override the role", async () => {
    signInAs("moderator");
    setChannel({ canPin: false, canDeleteOthers: false });
    mount([makeMessage()]);
    await open(text());
    expect(names()).not.toContain("Pin Message");
    expect(names()).not.toContain("Delete Message");
  });

  it("Pin on a pinned message reads Unpin and passes the current state", async () => {
    signInAs("moderator");
    mount([makeMessage({ pinned: true })]);
    await open(text());
    expect(names()).toContain("Unpin Message");
    item("msg-menu-pin")!.click();
    expect(opts.onPinClick).toHaveBeenCalledWith(1, 1, true);
  });

  it("Copy Text writes the raw content", async () => {
    mount([makeMessage({ content: "**bold** text" })]);
    await open(text());
    item("msg-menu-copy-text")!.click();
    expect(writeText).toHaveBeenCalledWith("**bold** text");
  });

  it("attachment-only message: no Copy Text", async () => {
    mount([makeMessage({ content: "" })]);
    await open(row());
    expect(names()).not.toContain("Copy Text");
    expect(names()).toContain("Reply");
  });

  it("selection inside the row adds Copy, which copies the selection", async () => {
    mount([makeMessage({ content: "hello world" })]);
    const node = document.createTreeWalker(text(), NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await open(text());
    expect(names()).toContain("Copy");
    item("msg-menu-copy")!.click();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("no Copy for a selection that is outside the row or collapsed", async () => {
    mount([makeMessage()]);
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await open(text());
    expect(names()).not.toContain("Copy");
    outside.remove();
  });

  it("quick reaction calls onReactionClick(id, emoji); Add Reaction opens the picker", async () => {
    mount([makeMessage()]);
    await open(text());
    item("msg-menu-quick-\u{1F44D}")!.click();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "\u{1F44D}");
    await open(text());
    item("msg-menu-add-reaction")!.click();
    expect(opts.onReactionClick).toHaveBeenLastCalledWith(1, "");
  });

  it("recent emoji come first in the quick row", async () => {
    localStorage.setItem("owncord:recent-emoji", JSON.stringify(["\u{1F680}"]));
    mount([makeMessage()]);
    await open(text());
    expect(names().slice(0, 3)).toEqual([
      "React with \u{1F680}",
      "React with \u{1F44D}",
      "React with ❤️",
    ]);
  });

  it("timed out: emoji row and Add Reaction disabled with the reason", async () => {
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    mount([makeMessage()]);
    await open(text());
    for (const el of [item("msg-menu-quick-\u{1F44D}")!, item("msg-menu-add-reaction")!]) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.title).not.toBe("");
      el.click();
    }
    expect(opts.onReactionClick).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("channel can_react=false locks reactions with the channel reason", async () => {
    setChannel({ canReact: false });
    mount([makeMessage()]);
    await open(text());
    expect(item("msg-menu-add-reaction")!.title).toBe("You can't add reactions in this channel");
  });

  it("20 distinct: new quick emoji left out, existing ones kept, Add Reaction disabled", async () => {
    const reactions = Array.from({ length: 19 }, (_, i) => ({
      emoji: `e${i}`,
      count: 1,
      me: false,
    }));
    reactions.push({ emoji: "\u{1F44D}", count: 2, me: false });
    mount([makeMessage({ reactions })]);
    await open(text());
    expect(names().slice(0, 1)).toEqual(["React with \u{1F44D}"]);
    expect(names()).not.toContain("React with ❤️");
    expect(names()).not.toContain("React with \u{1F602}");
    const add = item("msg-menu-add-reaction")!;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.title).toContain("reaction limit");
  });

  it("Shift+click Delete passes shiftKey=true; a plain click passes false", async () => {
    mount([mine()]);
    await open(text());
    item("msg-menu-delete")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
    expect(opts.onDeleteClick).toHaveBeenLastCalledWith(1, true);
    await open(text());
    item("msg-menu-delete")!.click();
    expect(opts.onDeleteClick).toHaveBeenLastCalledWith(1, false);
  });

  it("reconnecting: Delete disabled with the reason and does nothing", async () => {
    setConnectionStatus("reconnecting");
    mount([mine()]);
    await open(text());
    const del = item("msg-menu-delete")!;
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.title).not.toBe("");
    del.click();
    expect(opts.onDeleteClick).not.toHaveBeenCalled();
  });

  it("link target: Copy Link and Open Link; Open Link clicks the anchor", async () => {
    mount([makeMessage({ content: "see <https://example.com/page> now" })]);
    const anchor = text().querySelector<HTMLAnchorElement>('a[href^="http"]');
    expect(anchor).not.toBeNull();
    const seen: EventTarget[] = [];
    const spy = (e: Event): void => {
      e.preventDefault();
      seen.push(e.target!);
    };
    document.addEventListener("click", spy);
    try {
      await open(anchor!);
      expect(names().slice(0, 2)).toEqual(["Copy Link", "Open Link"]);
      item("msg-menu-copy-link")!.click();
      expect(writeText).toHaveBeenCalledWith(anchor!.getAttribute("href"));
      await open(anchor!);
      item("msg-menu-open-link")!.click();
      expect(seen).toContain(anchor);
    } finally {
      document.removeEventListener("click", spy);
    }
    // Off the link the same message has no link rows.
    await open(text());
    expect(names()).not.toContain("Copy Link");
  });

  describe("on a phone", () => {
    const sheetItem = (testId: string): HTMLElement | null =>
      sheet()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
    async function press(target: Element): Promise<void> {
      rightClick(target);
      await vi.waitFor(() => expect(sheet()).not.toBeNull());
    }

    beforeEach(() => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("pointer: coarse") }));
    });
    afterEach(() => {
      sheet()?.remove();
      document
        .querySelectorAll(".bottom-sheet, .bottom-sheet-backdrop")
        .forEach((el) => el.remove());
      vi.unstubAllGlobals();
    });

    it("a message with one link offers it wherever the row is pressed", async () => {
      mount([
        makeMessage({ content: "see <https://example.com/page> and <https://example.com/page>" }),
      ]);
      await press(text());
      expect(sheetItem("msg-menu-open-link")).not.toBeNull();
      expect(sheetItem("msg-menu-copy-message-link")).not.toBeNull();
      sheetItem("msg-menu-copy-link")!.click();
      expect(writeText).toHaveBeenCalledWith("https://example.com/page");
    });

    it("a message with two different links offers only the one pressed", async () => {
      mount([makeMessage({ content: "<https://a.example/> or <https://b.example/>" })]);
      await press(text());
      expect(sheetItem("msg-menu-copy-link")).toBeNull();
      sheet()?.remove();
      const second = text().querySelectorAll<HTMLAnchorElement>('a[href^="http"]')[1]!;
      await press(second);
      sheetItem("msg-menu-copy-link")!.click();
      expect(writeText).toHaveBeenCalledWith(second.getAttribute("href"));
    });
  });

  it("image right-click opens the image menu, not this one", async () => {
    mount([makeMessage()]);
    const img = document.createElement("img");
    img.setAttribute("src", "data:image/png;base64,AAAA");
    text().appendChild(img);
    bindImageMenu({ img, link: null, save: () => Promise.resolve() });
    rightClick(img);
    await vi.waitFor(() => expect(document.querySelector(".image-context-menu")).not.toBeNull());
    await settled();
    expect(menu()).toBeNull();
    closeActiveLightbox();
  });

  it("textarea in the list: default not prevented, no menu", async () => {
    mount([makeMessage()]);
    const area = document.createElement("textarea");
    text().appendChild(area);
    const e = rightClick(area);
    await settled();
    expect(e.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it.each([
    ["deleted", { deleted: true }],
    ["pending", { status: "pending" as const, correlationId: "c1" }],
    ["system", { user: { id: 0, username: "System", avatar: null } }],
  ])("%s row: no menu", async (_n, patch) => {
    mount([makeMessage({ id: 5, ...patch })]);
    const target = container.querySelector<HTMLElement>(`[data-testid="message-5"]`) ?? container;
    rightClick(target);
    await settled();
    expect(menu()).toBeNull();
  });

  it("keyboard contextmenu (0,0): anchored to the row, first item focused, Escape returns focus", async () => {
    mount([makeMessage()]);
    row().getBoundingClientRect = () =>
      ({ left: 0, top: 120, right: 500, bottom: 160, width: 500, height: 40 }) as DOMRect;
    const invoker = row().querySelector<HTMLElement>('[data-testid="msg-reply-1"]')!;
    invoker.focus();
    await open(invoker, { clientX: 0, clientY: 0 });
    expect(menu()!.style.left).toBe("500px");
    expect(menu()!.style.top).toBe("120px");
    await vi.waitFor(() => expect(document.activeElement).toBe(items()[0]));
    items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it("arrow keys skip a disabled row", async () => {
    setChannel({ canReact: false });
    mount([makeMessage()]);
    await open(text());
    // Every reaction row is disabled, so the first reachable row is Reply.
    await vi.waitFor(() => expect(nameOf(document.activeElement as HTMLElement)).toBe("Reply"));
  });

  it("list destroy closes the menu", async () => {
    mount([makeMessage()]);
    await open(text());
    list.destroy?.();
    expect(menu()).toBeNull();
  });

  // -- The design's two edge cases -------------------------------------------

  it.each([
    ["deleted", () => seed([mine({ deleted: true })])],
    ["gone", () => seed([])],
  ])("message %s while open: Delete, Edit, Reply and Pin do nothing", async (_name, change) => {
    for (const id of [
      "msg-menu-delete",
      "msg-menu-edit",
      "msg-menu-reply",
      "msg-menu-pin",
      "msg-menu-copy-text",
      "msg-menu-copy-message-link",
    ]) {
      signInAs("moderator");
      mount([mine()]);
      await open(text());
      change();
      // The menu is owned by the list, not the row: it is still up.
      expect(menu()).not.toBeNull();
      item(id)!.click();
      expect(menu()).toBeNull();
      list.destroy?.();
    }
    expect(opts.onDeleteClick).not.toHaveBeenCalled();
    expect(opts.onEditClick).not.toHaveBeenCalled();
    expect(opts.onReplyClick).not.toHaveBeenCalled();
    expect(opts.onPinClick).not.toHaveBeenCalled();
  });

  it("connection drops while open: Delete does nothing", async () => {
    mount([mine()]);
    await open(text());
    setConnectionStatus("disconnected");
    item("msg-menu-delete")!.click();
    expect(opts.onDeleteClick).not.toHaveBeenCalled();
  });

  it("row rebuilt while open: menu survives and Escape focuses the replacement", async () => {
    mount([makeMessage({ content: "before" })]);
    const oldRow = row();
    const invoker = oldRow.querySelector<HTMLElement>('[data-testid="msg-reply-1"]')!;
    invoker.focus();
    await open(invoker, { clientX: 0, clientY: 0 });
    // A new render of the same message (an edit) replaces the row's elements.
    seed([makeMessage({ content: "after", editedAt: "2024-01-15T12:05:00Z" })]);
    await vi.waitFor(() => expect(invoker.isConnected).toBe(false));
    expect(menu()).not.toBeNull();
    const fresh = row().querySelector<HTMLElement>("button, [tabindex='0'], a[href]")!;
    // The menu's own actions still work after the rebuild.
    items()[0]!.focus();
    items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(fresh);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("row rebuilt while open: Open Link clicks the live anchor", async () => {
    mount([makeMessage({ content: "see <https://example.com/page> now" })]);
    const old = text().querySelector<HTMLAnchorElement>('a[href^="http"]')!;
    const seen: EventTarget[] = [];
    const spy = (e: Event): void => {
      e.preventDefault();
      seen.push(e.target!);
    };
    document.addEventListener("click", spy);
    try {
      await open(old);
      seed([
        makeMessage({
          content: "see <https://example.com/page> now!",
          editedAt: "2024-01-15T12:05:00Z",
        }),
      ]);
      await vi.waitFor(() => expect(old.isConnected).toBe(false));
      const fresh = text().querySelector<HTMLAnchorElement>('a[href^="http"]')!;
      item("msg-menu-open-link")!.click();
      expect(seen.filter((t) => t instanceof HTMLAnchorElement)).toEqual([fresh]);
    } finally {
      document.removeEventListener("click", spy);
    }
  });

  it("pinned by someone else while open: Pin does nothing instead of unpinning", async () => {
    signInAs("moderator");
    mount([makeMessage({ pinned: false })]);
    await open(text());
    expect(names()).toContain("Pin Message");
    seed([makeMessage({ pinned: true })]);
    item("msg-menu-pin")!.click();
    expect(opts.onPinClick).not.toHaveBeenCalled();
  });

  it("Copy Text and Copy show a success toast", async () => {
    const { toasts } = await import("@lib/ui/toast").then((m) => ({ toasts: m }));
    const spy = vi.spyOn(toasts, "showToast");
    mount([makeMessage({ content: "hello" })]);
    await open(text());
    item("msg-menu-copy-text")!.click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("Copied", "success"));
    spy.mockRestore();
  });

  it("the quick reactions are a named group; Left/Right move inside it", async () => {
    mount([makeMessage()]);
    await open(text());
    const group = menu()!.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Quick reactions");
    const [a, b, c] = [...group.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    await vi.waitFor(() => expect(document.activeElement).toBe(a));
    const key = (el: HTMLElement, k: string): void => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    };
    key(a!, "ArrowRight");
    expect(document.activeElement).toBe(b);
    key(b!, "ArrowRight");
    key(c!, "ArrowRight");
    expect(document.activeElement).toBe(c);
    key(c!, "ArrowLeft");
    expect(document.activeElement).toBe(b);
  });

  it("Forward follows Reply and calls the forward callback with the message id", async () => {
    mount([makeMessage()], { onForwardClick: vi.fn() });
    await open(text());
    const ids = items().map((el) => el.getAttribute("data-testid"));
    expect(ids.indexOf("msg-menu-forward")).toBe(ids.indexOf("msg-menu-reply") + 1);
    expect(item("msg-menu-forward")?.textContent).toBe("Forward");
    item("msg-menu-forward")!.click();
    expect(opts.onForwardClick).toHaveBeenCalledWith(1);
  });

  it("no Forward without the callback", async () => {
    mount([makeMessage()]);
    await open(text());
    expect(item("msg-menu-forward")).toBeNull();
  });

  it("connection drops while open: Forward does nothing", async () => {
    mount([makeMessage()], { onForwardClick: vi.fn() });
    await open(text());
    setConnectionStatus("disconnected");
    item("msg-menu-forward")!.click();
    expect(opts.onForwardClick).not.toHaveBeenCalled();
  });

  it("no Edit on my own forwarded message", async () => {
    const forward = {
      source_channel_id: 5,
      source_message_id: 9,
      source_timestamp: "2025-01-10T09:00:00Z",
    };
    mount([mine({ forward })]);
    await open(text());
    expect(item("msg-menu-edit")).toBeNull();
    expect(item("msg-menu-reply")).not.toBeNull();
  });

  it("row rebuilt while open: an action still reaches the callback", async () => {
    mount([makeMessage({ content: "before" })]);
    await open(text());
    seed([makeMessage({ content: "after", editedAt: "2024-01-15T12:05:00Z" })]);
    await vi.waitFor(() => expect(text().textContent).toContain("after"));
    item("msg-menu-reply")!.click();
    expect(opts.onReplyClick).toHaveBeenCalledWith(1);
  });
});

describe("message menu module", () => {
  it("opening for a vanished message opens nothing", async () => {
    resetGateStores();
    seed([]);
    const { openMessageMenu } = await import("@components/message-list/messageMenu");
    openMessageMenu({
      msg: OTHER_MSG(),
      opts: makeOpts(),
      x: 1,
      y: 1,
      target: null,
      signal: new AbortController().signal,
    });
    expect(menu()).toBeNull();
  });

  it("an invoker is marked expanded while open and gets focus back", async () => {
    resetGateStores();
    signInAs("member");
    setChannel();
    seed([OTHER_MSG()]);
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    const { openMessageMenu, closeMessageMenu } =
      await import("@components/message-list/messageMenu");
    const ac = new AbortController();
    openMessageMenu({
      msg: OTHER_MSG(),
      opts: makeOpts(),
      x: 1,
      y: 1,
      target: null,
      signal: ac.signal,
      invoker,
    });
    expect(invoker.getAttribute("aria-expanded")).toBe("true");
    // The menu took focus; a programmatic close must hand it back.
    await vi.waitFor(() => expect(document.activeElement).not.toBe(invoker));
    closeMessageMenu();
    expect(invoker.getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(invoker);

    // Same for the owning list's signal aborting.
    openMessageMenu({
      msg: OTHER_MSG(),
      opts: makeOpts(),
      x: 1,
      y: 1,
      target: null,
      signal: ac.signal,
      invoker,
    });
    await vi.waitFor(() => expect(document.activeElement).not.toBe(invoker));
    ac.abort();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});

function OTHER_MSG(): Message {
  return makeMessage({ user: { id: OTHER, username: "alice", avatar: null } });
}
