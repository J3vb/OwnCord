import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import type { Message } from "@stores/messages.store";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import {
  ME,
  makeMessage,
  makeOpts,
  resetGateStores,
  seedMessages as seed,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

const SHEET = '[data-testid="message-sheet"]';

function mine(over: Partial<Message> = {}): Message {
  return makeMessage({ user: { id: ME, username: "me", avatar: null }, ...over });
}

const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(SHEET);
const nameOf = (el: HTMLElement): string => el.getAttribute("aria-label") ?? el.textContent ?? "";
const quick = (): string[] =>
  [...(sheet()?.querySelectorAll<HTMLElement>(".msg-sheet-quick button") ?? [])].map(nameOf);
const sections = (): string[][] =>
  [...(sheet()?.querySelectorAll<HTMLElement>(".msg-sheet-section") ?? [])].map((s) =>
    [...s.querySelectorAll<HTMLElement>("button")].map(nameOf),
  );
const button = (testId: string): HTMLElement | null =>
  [...(sheet()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
    (el) => el.dataset["testid"] === testId,
  ) ?? null;

describe("message actions sheet on a phone", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;
  let opts: MessageListOptions;

  function mount(messages: Message[], over: Partial<MessageListOptions> = {}): void {
    seed(messages);
    opts = makeOpts(over);
    list = createMessageList(opts);
    list.mount(container);
  }
  const text = (id = 1): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="message-${id}"] .msg-text`)!;

  async function longPress(target: Element): Promise<void> {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
    );
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
  }

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      closeBottomSheet();
      list?.destroy?.();
      resetGateStores();
      vi.unstubAllGlobals();
    },
  );

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("pointer: coarse") }));
    resetGateStores();
    localStorage.clear();
    signInAs("member");
    setChannel();
    resetMembersState();
  });

  it("opens the sheet, not the menu, with four large quick reactions and Add Reaction", async () => {
    mount([mine()]);
    await longPress(text());
    expect(document.querySelector(".message-context-menu")).toBeNull();
    expect(quick()).toEqual([
      "React with \u{1F44D}",
      "React with ❤️",
      "React with \u{1F602}",
      "React with \u{1F440}",
      "Add Reaction",
    ]);
    expect(button("msg-menu-add-reaction")?.textContent).toBe("+");
  });

  it("keeps the menu's rows and order, with Delete and Report in their own group", async () => {
    signInAs("moderator");
    mount([makeMessage()], { onReportClick: vi.fn() });
    await longPress(text());
    const groups = sections();
    expect(groups.at(-1)).toEqual(["Delete Message", "Report Message"]);
    expect(groups.at(0)).toEqual(
      expect.arrayContaining(["Reply", "Copy Text", "Pin Message", "Copy Message Link"]),
    );
    expect(button("msg-menu-delete")?.classList.contains("danger")).toBe(true);
    expect(button("msg-menu-edit")).toBeNull();
  });

  it("closes, then runs the row's action through the list's callbacks", async () => {
    mount([mine()]);
    await longPress(text());
    button("msg-menu-reply")!.click();
    expect(sheet()).toBeNull();
    expect(opts.onReplyClick).toHaveBeenCalledWith(1);

    await longPress(text());
    button("msg-menu-add-reaction")!.click();
    expect(sheet()).toBeNull();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "");
  });

  it("a locked row stays in the sheet and does nothing", async () => {
    setChannel({ canReact: false });
    mount([mine()]);
    await longPress(text());
    const first = sheet()!.querySelector<HTMLElement>(".msg-sheet-quick button")!;
    expect(first.getAttribute("aria-disabled")).toBe("true");
    first.click();
    expect(sheet()).not.toBeNull();
    expect(opts.onReactionClick).not.toHaveBeenCalled();
  });

  it("a row tapped after the message was deleted does nothing", async () => {
    mount([mine()]);
    await longPress(text());
    seed([mine({ deleted: true })]);
    button("msg-menu-reply")!.click();
    expect(opts.onReplyClick).not.toHaveBeenCalled();
  });

  it("closes when the list it belongs to is torn down", async () => {
    mount([mine()]);
    await longPress(text());
    list.destroy?.();
    expect(sheet()).toBeNull();
  });
});
