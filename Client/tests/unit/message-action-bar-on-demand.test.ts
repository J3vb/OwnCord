import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "../../src/features/messaging/MessageList";
import { renderMessage } from "../../src/features/messaging/message-list/renderers";
import { installPhoneGestures } from "../../src/pages/main-page/phoneGestures";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import {
  makeMessage,
  makeOpts,
  resetGateStores,
  seedMessages as seed,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { swipe } from "../helpers/touch";
import "../helpers/resizeObserverStub";

const barIds = (row: Element): string[] =>
  [...row.querySelectorAll<HTMLElement>(".msg-actions-bar button")].map(
    (b) => b.dataset["testid"] ?? "",
  );

describe("message action bar on demand", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;
  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`)!;

  beforeEach(() => {
    resetGateStores();
    signInAs("moderator");
    setChannel();
    container = document.createElement("div");
    document.body.appendChild(container);
    seed([makeMessage({ id: 1 }), makeMessage({ id: 2 }), makeMessage({ id: 3 })]);
    list = createMessageList(makeOpts());
    list.mount(container);
  });

  afterEach(() => {
    list.destroy?.();
    container.remove();
    resetGateStores();
  });

  const hover = (id: number): void => {
    row(id).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  };

  it("a row that was never hovered has exactly one button", () => {
    expect(barIds(row(1))).toEqual(["msg-more-1"]);
    expect(barIds(row(2))).toEqual(["msg-more-2"]);
  });

  it("hovering a row builds its bar, with the buttons before More", () => {
    hover(2);
    const ids = barIds(row(2));
    expect(ids.length).toBeGreaterThan(3);
    expect(ids.at(-1)).toBe("msg-more-2");
    expect(ids).toContain("msg-react-2");
    expect(ids).toContain("msg-reply-2");
    expect(barIds(row(1))).toEqual(["msg-more-1"]);
  });

  it("focus entering a row builds that row's bar", () => {
    row(1).querySelector<HTMLElement>("[data-testid='msg-more-1']")!.focus();
    expect(barIds(row(1))).toContain("msg-react-1");
  });

  const keyboardFocusIn = (target: Element, from: Element | null): void => {
    const spy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ":focus-visible" ? true : Element.prototype.matches.call(this, selector);
    });
    try {
      target.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));
    } finally {
      spy.mockRestore();
    }
  };

  it("keyboard focus entering the list builds every bar, and rows drawn while it stays", () => {
    keyboardFocusIn(row(1).querySelector("[data-testid='msg-more-1']")!, null);
    for (const id of [1, 2, 3]) expect(barIds(row(id))).toContain(`msg-react-${id}`);
  });

  it("Tab forward onto a never-hovered row's More moves to the bar's first button", () => {
    const more = row(2).querySelector<HTMLElement>("[data-testid='msg-more-2']")!;
    const before = row(1).querySelector<HTMLElement>("[data-testid='msg-more-1']")!;
    keyboardFocusIn(more, before);
    expect(document.activeElement).toBe(
      row(2).querySelector("[data-testid='msg-quick-react-2-0']"),
    );
  });

  it("Shift+Tab onto a never-hovered row's More stays on More", () => {
    const more = row(1).querySelector<HTMLElement>("[data-testid='msg-more-1']")!;
    const after = row(2).querySelector<HTMLElement>("[data-testid='msg-more-2']")!;
    more.focus();
    keyboardFocusIn(more, after);
    expect(document.activeElement).toBe(more);
  });

  it("a bar built while offline has Delete locked, and it unlocks on reconnect", () => {
    setConnectionStatus("disconnected");
    uiStore.flush();
    hover(1);
    const del = row(1).querySelector<HTMLButtonElement>("[data-testid='msg-delete-1']")!;
    expect(del.disabled).toBe(true);
    setConnectionStatus("connected");
    uiStore.flush();
    expect(del.disabled).toBe(false);
  });
});

describe("swipe to reply on a row that was never hovered", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("builds the bar and starts the reply", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    resetGateStores();
    signInAs("member");
    setChannel();
    const ac = new AbortController();
    const onReplyClick = vi.fn();
    const msg = makeMessage({ id: 5 });
    const chat = document.createElement("div");
    chat.innerHTML = `<div class="messages-region"><div class="messages-container"></div></div>`;
    const el = renderMessage(msg, false, [msg], makeOpts({ onReplyClick }), ac.signal);
    chat.querySelector(".messages-container")!.appendChild(el);
    document.body.appendChild(chat);
    installPhoneGestures({
      signal: ac.signal,
      chatArea: chat,
      drawerSurfaces: [],
      memberColumn: document.createElement("div"),
      drawer: () => ({ open: vi.fn(), close: vi.fn(), isOpen: () => false }),
      members: () => ({
        openOverlay: vi.fn(() => true),
        closeOverlay: vi.fn(),
        isOverlayOpen: () => false,
      }),
    });
    expect(barIds(el)).toEqual(["msg-more-5"]);

    swipe(el.querySelector(".msg-text") ?? el, [300, 100], [200, 100]);

    expect(onReplyClick).toHaveBeenCalledWith(5);
    ac.abort();
  });
});
