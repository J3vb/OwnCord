import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/messageActions";
import { shouldGroup } from "@lib/text/formatting";
import type { Message } from "@stores/messages.store";
import { voiceStore } from "@stores/voice.store";
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
import "../helpers/resizeObserverStub";
import {
  expectNoRowMenu,
  messageMenuNames,
  openRowMenu,
  seedChannelOneRows,
  shownActions,
} from "../helpers/readOnlyRowMenu";

const START = "2024-01-15T12:00:00Z";

function callRow(over: Partial<Message> & { endedAt?: string | null; who?: number[] } = {}) {
  const { endedAt = null, who = [OTHER], ...rest } = over;
  return makeMessage({
    id: 5,
    kind: "call",
    content: "started a call.",
    call: { started_at: START, ended_at: endedAt, participants: who },
    ...rest,
  });
}

function render(msg: Message, over = {}): HTMLElement {
  const ac = new AbortController();
  return renderMessage(msg, false, [msg], makeOpts(over), ac.signal);
}
const textOf = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("call log row renderer", () => {
  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel({ type: "dm" });
    voiceStore.setState((s) => ({ ...s, currentChannelId: null, voiceStatus: "idle" }));
  });
  afterEach(() => resetGateStores());

  it("live: 'started a call' with a Join button that joins this DM", () => {
    const onJoinCall = vi.fn();
    const el = render(callRow(), { onJoinCall });
    expect(el.classList.contains("call-row")).toBe(true);
    expect(textOf(el)).toContain("alice started a call");
    const join = el.querySelector<HTMLButtonElement>('[data-testid="call-join-5"]')!;
    join.click();
    expect(onJoinCall).toHaveBeenCalledWith(1);
  });

  it("live: no Join when already in that call, or without a handler", () => {
    voiceStore.setState((s) => ({ ...s, currentChannelId: 1, voiceStatus: "connected" }));
    expect(render(callRow(), { onJoinCall: vi.fn() }).querySelector("button")).toBeNull();
    voiceStore.setState((s) => ({ ...s, currentChannelId: null, voiceStatus: "idle" }));
    expect(render(callRow()).querySelector("button")).toBeNull();
  });

  it("ended, viewer in participants: lasted N minutes (plural aware)", () => {
    const five = callRow({ endedAt: "2024-01-15T12:05:00Z", who: [OTHER, ME] });
    expect(textOf(render(five))).toContain("alice started a call that lasted 5 minutes");
    const one = callRow({ endedAt: "2024-01-15T12:01:10Z", who: [ME] });
    expect(textOf(render(one))).toContain("lasted 1 minute");
    expect(render(five).querySelector("button")).toBeNull();
  });

  it("ended under a minute: 'a few seconds'", () => {
    const el = render(callRow({ endedAt: "2024-01-15T12:00:20Z", who: [ME] }));
    expect(textOf(el)).toContain("lasted a few seconds");
  });

  it("ended, viewer never joined: 'You missed a call from X', styled as missed", () => {
    const el = render(callRow({ endedAt: "2024-01-15T12:05:00Z" }));
    expect(textOf(el)).toContain("You missed a call from alice");
    expect(el.classList.contains("call-missed")).toBe(true);
    expect(el.querySelector('[data-icon="phone-off"], svg')).not.toBeNull();
  });

  it("the author is never 'missed' even when absent from participants", () => {
    const el = render(
      callRow({
        endedAt: "2024-01-15T12:05:00Z",
        who: [],
        user: { id: ME, username: "me", avatar: null },
      }),
    );
    expect(el.classList.contains("call-missed")).toBe(false);
    expect(textOf(el)).toContain("started a call that lasted 5 minutes");
  });

  it("never infers a call from content, and an unknown kind shows content as system text", () => {
    const fake = makeMessage({ content: "started a call that lasted 5 minutes" });
    expect(render(fake).classList.contains("call-row")).toBe(false);
    const future = makeMessage({ kind: "poll", content: "Alice opened a poll" });
    const el = render(future);
    expect(el.classList.contains("system-msg")).toBe(true);
    expect(textOf(el)).toContain("Alice opened a poll");
    const noCall = makeMessage({ kind: "call", content: "fallback text" });
    expect(textOf(render(noCall))).toContain("fallback text");
  });

  it("is never grouped with a neighbour from the same author", () => {
    const call = callRow();
    const next = makeMessage({ id: 6, timestamp: "2024-01-15T12:00:05Z" });
    const prev = makeMessage({ id: 4, timestamp: "2024-01-15T11:59:55Z" });
    expect(shouldGroup(prev, call)).toBe(false);
    expect(shouldGroup(call, next)).toBe(false);
    expect(shouldGroup(prev, next)).toBe(true);
  });
});

describe("call log row actions", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;

  beforeEach(() => {
    resetGateStores();
    localStorage.clear();
    signInAs("moderator");
    setChannel({ type: "dm" });
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
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

  function mount(): HTMLElement {
    seedChannelOneRows([callRow({ endedAt: "2024-01-15T12:05:00Z", who: [ME] })]);
    list = createMessageList(makeOpts({ channelType: "dm" }));
    list.mount(container);
    return container.querySelector<HTMLElement>('[data-testid="message-5"]')!;
  }
  const menuNames = messageMenuNames;

  it("gates: only Copy ID can show, and only in developer mode", () => {
    const msg = callRow({ user: { id: ME, username: "me", avatar: null } });
    setDeveloperMode(true);
    const g = messageActionGates(msg, makeOpts({ onReportClick: vi.fn() }));
    expect(shownActions(g)).toEqual([false, false, false, false, false]);
    expect(g.copyId.shown).toBe(true);
  });

  it("no hover bar, and the right-click menu offers only Copy Message ID", async () => {
    setDeveloperMode(true);
    const row = mount();
    expect(row.querySelector(".msg-actions-bar")).toBeNull();
    openRowMenu(row);
    await vi.waitFor(() => expect(menuNames()).toEqual(["Copy Message ID"]));
  });

  it("without developer mode there is no menu at all", async () => {
    const row = mount();
    await expectNoRowMenu(row);
  });
});
