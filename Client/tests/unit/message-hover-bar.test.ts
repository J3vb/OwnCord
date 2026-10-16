import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom does not provide ResizeObserver; stub it so MessageList can mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { renderMessage } from "@components/message-list/renderers";
import { messagesStore, type Message } from "@stores/messages.store";
import { setConnectionStatus } from "@stores/ui.store";
import { setActiveTimeout } from "../../src/features/safety/store";
import {
  ME,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";

const UP = "\u{1F44D}";

function seed(messages: Message[]): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map([[1, messages]]),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
}

const mine = (over: Partial<Message> = {}): Message =>
  makeMessage({ user: { id: ME, username: "me", avatar: null }, ...over });

describe("message hover bar (WP 3A-7)", () => {
  let container: HTMLDivElement;
  let ac: AbortController;

  beforeEach(() => {
    resetGateStores();
    localStorage.clear();
    signInAs("moderator");
    setChannel();
    container = document.createElement("div");
    document.body.appendChild(container);
    ac = new AbortController();
  });

  afterEach(() => {
    ac.abort();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    resetGateStores();
  });

  function render(msg: Message, over: Partial<MessageListOptions> = {}): MessageListOptions {
    const opts = makeOpts(over);
    container.appendChild(renderMessage(msg, false, [msg], opts, ac.signal));
    return opts;
  }
  const bar = (): HTMLElement => container.querySelector<HTMLElement>(".msg-actions-bar")!;
  const ids = (): string[] =>
    [...bar().querySelectorAll<HTMLElement>("button")].map((b) => b.dataset["testid"] ?? "");
  const btn = (id: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

  it("own message: quick emoji, React, Edit, then Pin, Delete, Reply (Shift only), More last", () => {
    render(mine());
    expect(ids()).toEqual([
      "msg-quick-react-1-0",
      "msg-quick-react-1-1",
      "msg-quick-react-1-2",
      "msg-react-1",
      "msg-edit-1",
      "msg-reply-1",
      "msg-pin-1",
      "msg-delete-1",
      "msg-more-1",
    ]);
    expect(btn("msg-reply-1").classList.contains("msg-shift-only")).toBe(true);
    expect(btn("msg-pin-1").classList.contains("msg-shift-only")).toBe(true);
    expect(btn("msg-delete-1").classList.contains("msg-shift-only")).toBe(true);
    expect(btn("msg-edit-1").classList.contains("msg-shift-only")).toBe(false);
  });

  it("someone else's message: Reply is always shown and there is no Edit", () => {
    render(makeMessage());
    expect(btn("msg-edit-1")).toBeNull();
    expect(btn("msg-reply-1").classList.contains("msg-shift-only")).toBe(false);
  });

  it("Copy Message Link, Report and Copy ID are not on the bar", () => {
    localStorage.setItem("owncord:settings:developerMode", "true");
    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
    );
    render(makeMessage(), { onReportClick: vi.fn() });
    expect(ids().filter((i) => /copy|report/.test(i))).toEqual([]);
    localStorage.setItem("owncord:settings:developerMode", "false");
    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
    );
  });

  it("gates still hide Pin and Delete from a plain member on someone else's message", () => {
    signInAs("member");
    render(makeMessage());
    expect(btn("msg-pin-1")).toBeNull();
    expect(btn("msg-delete-1")).toBeNull();
    expect(btn("msg-more-1")).not.toBeNull();
  });

  it("quick emoji: labelled, and a click calls onReactionClick(id, emoji)", () => {
    const opts = render(makeMessage());
    const first = btn("msg-quick-react-1-0");
    expect(first.getAttribute("aria-label")).toBe(`React with ${UP}`);
    expect(first.textContent).toBe(UP);
    first.click();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, UP);
  });

  it("quick emoji follow the recent picks", () => {
    localStorage.setItem("owncord:recent-emoji", JSON.stringify(["\u{1F680}"]));
    render(makeMessage());
    expect(btn("msg-quick-react-1-0").getAttribute("aria-label")).toBe("React with \u{1F680}");
  });

  it("timed out: quick emoji are locked with the reason and do nothing", () => {
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    const opts = render(makeMessage());
    const first = btn("msg-quick-react-1-0");
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.title).not.toBe(`React with ${UP}`);
    first.click();
    expect(opts.onReactionClick).not.toHaveBeenCalled();
  });

  it("offline: quick emoji are locked", () => {
    setConnectionStatus("reconnecting");
    const opts = render(makeMessage());
    btn("msg-quick-react-1-1").click();
    expect(btn("msg-quick-react-1-1").getAttribute("aria-disabled")).toBe("true");
    expect(opts.onReactionClick).not.toHaveBeenCalled();
  });

  it("20 distinct: new quick emoji are left out, one already on the message stays", () => {
    const reactions = Array.from({ length: 19 }, (_, i) => ({
      emoji: `e${i}`,
      count: 1,
      me: false,
    }));
    reactions.push({ emoji: UP, count: 2, me: false });
    render(makeMessage({ reactions }));
    const quick = [...bar().querySelectorAll("button.msg-quick-react")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(quick).toEqual([`React with ${UP}`]);
  });

  it("React still opens the picker with an empty emoji", () => {
    const opts = render(makeMessage());
    btn("msg-react-1").click();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "");
  });

  it("Shift+click Delete passes shiftKey=true", () => {
    const opts = render(mine());
    btn("msg-delete-1").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(opts.onDeleteClick).toHaveBeenLastCalledWith(1, true);
    btn("msg-delete-1").click();
    expect(opts.onDeleteClick).toHaveBeenLastCalledWith(1, false);
  });

  describe("More button", () => {
    it("is a menu button, closed at first", () => {
      render(makeMessage());
      const more = btn("msg-more-1");
      expect(more.getAttribute("aria-haspopup")).toBe("menu");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(more.getAttribute("aria-label")).toBe("More");
    });

    it("opens the message menu with itself as the invoker, and Escape returns focus", async () => {
      seed([makeMessage()]);
      render(makeMessage());
      const more = btn("msg-more-1");
      more.focus();
      more.click();
      await vi.waitFor(() =>
        expect(document.querySelector(".message-context-menu")).not.toBeNull(),
      );
      expect(more.getAttribute("aria-expanded")).toBe("true");
      document
        .querySelector(".message-context-menu")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector(".message-context-menu")).toBeNull());
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(more);
    });

    it("menu holds the items the bar dropped: Copy Message Link and Report", async () => {
      seed([makeMessage()]);
      render(makeMessage(), { onReportClick: vi.fn() });
      btn("msg-more-1").click();
      await vi.waitFor(() =>
        expect(document.querySelector(".message-context-menu")).not.toBeNull(),
      );
      const labels = [...document.querySelectorAll(".message-context-menu [role=menuitem]")].map(
        (el) => el.getAttribute("aria-label") ?? el.textContent,
      );
      expect(labels).toContain("Copy Message Link");
      expect(labels).toContain("Report Message");
    });
  });
});

describe("hover bar Shift tracking", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;
  const root = (): HTMLElement => container.querySelector<HTMLElement>(".messages-container")!;
  const key = (type: "keydown" | "keyup", shiftKey: boolean): void => {
    window.dispatchEvent(new KeyboardEvent(type, { key: "Shift", shiftKey }));
  };

  beforeEach(() => {
    resetGateStores();
    signInAs("moderator");
    setChannel();
    container = document.createElement("div");
    document.body.appendChild(container);
    seed([mine()]);
    list = createMessageList(makeOpts());
    list.mount(container);
  });

  afterEach(() => {
    list.destroy?.();
    container.remove();
    resetGateStores();
  });

  it("toggles shift-held on the list root with Shift down and up", () => {
    expect(root().classList.contains("shift-held")).toBe(false);
    key("keydown", true);
    expect(root().classList.contains("shift-held")).toBe(true);
    key("keyup", false);
    expect(root().classList.contains("shift-held")).toBe(false);
  });

  it("resets on window blur", () => {
    key("keydown", true);
    window.dispatchEvent(new Event("blur"));
    expect(root().classList.contains("shift-held")).toBe(false);
  });

  it("resets when the tab is hidden", () => {
    key("keydown", true);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    expect(root().classList.contains("shift-held")).toBe(false);
  });

  it("the list's rows carry Pin and Delete (CSS hides them without Shift)", () => {
    const del = container.querySelector("[data-testid='msg-delete-1']");
    expect(del?.classList.contains("msg-shift-only")).toBe(true);
  });

  it("stops listening after destroy", () => {
    const r = root();
    list.destroy?.();
    key("keydown", true);
    expect(r.classList.contains("shift-held")).toBe(false);
  });
});
