import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageActionGates } from "../../src/components/message-list/message-actions";
import { renderMessage } from "../../src/components/message-list/renderers";
import {
  refreshThreadChips,
  threadAgoLabel,
  threadCountLabel,
} from "../../src/components/message-list/threadChip";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import { removeThread, resetThreadsStore, upsertThread } from "../../src/stores/threads.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { makeThread } from "../helpers/thread-fixtures";

const msg = () => makeMessage({ user: { id: OTHER, username: "alice", avatar: null } });
const opts = (over = {}) =>
  makeOpts({ channelType: "text", onCreateThreadClick: vi.fn(), ...over });

beforeEach(() => {
  resetGateStores();
  signInAs("member");
  setChannel();
  applyReadyCapabilities({ threads: true });
});
afterEach(() => {
  resetServerCapabilities();
  resetThreadsStore();
  resetGateStores();
});

describe("Create Thread gate", () => {
  it("is offered in a text channel the user can post in, on a message with no thread", () => {
    expect(messageActionGates(msg(), opts()).createThread.shown).toBe(true);
  });

  it("is hidden without the threads capability", () => {
    applyReadyCapabilities({});
    expect(messageActionGates(msg(), opts()).createThread.shown).toBe(false);
  });

  it.each(["announcement", "voice", "dm", "thread"])("is hidden in a %s", (type) => {
    expect(messageActionGates(msg(), opts({ channelType: type })).createThread.shown).toBe(false);
  });

  it("is hidden when the user cannot send", () => {
    setChannel({ canSend: false });
    expect(messageActionGates(msg(), opts()).createThread.shown).toBe(false);
  });

  it("is hidden when the message already has a thread, from the row or from a live frame", () => {
    const withRow = makeMessage({ thread: makeThread() });
    expect(messageActionGates(withRow, opts()).createThread.shown).toBe(false);
    upsertThread(makeThread({ id: 5, starter_message_id: 1 }));
    expect(messageActionGates(msg(), opts()).createThread.shown).toBe(false);
  });

  it("is offered again once the thread was deleted", () => {
    const withRow = makeMessage({ thread: makeThread() });
    removeThread(91);
    expect(messageActionGates(withRow, opts()).createThread.shown).toBe(true);
  });

  it("needs the list to supply the callback, and a confirmed message", () => {
    expect(messageActionGates(msg(), makeOpts({ channelType: "text" })).createThread.shown).toBe(
      false,
    );
    expect(messageActionGates(makeMessage({ status: "pending" }), opts()).createThread.shown).toBe(
      false,
    );
  });

  it("applies to your own message too", () => {
    const own = makeMessage({ user: { id: ME, username: "me", avatar: null } });
    expect(messageActionGates(own, opts()).createThread.shown).toBe(true);
  });
});

describe("starter chip", () => {
  const render = (
    m = makeMessage({ thread: makeThread() }),
    onOpenThread?: (id: number) => void,
  ) => {
    const ac = new AbortController();
    const el = renderMessage(
      m,
      false,
      [m],
      makeOpts(onOpenThread ? { onOpenThread } : {}),
      ac.signal,
    );
    document.body.appendChild(el);
    return el;
  };
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows the name, the count and the time under the body", () => {
    const chip = render().querySelector<HTMLElement>('[data-testid="thread-chip-91"]')!;
    expect(chip.textContent).toContain("Release plan");
    expect(chip.textContent).toContain("7 messages");
    expect(chip.textContent).toMatch(/ago|just now/);
    expect(chip.querySelector('[data-testid="thread-chip-archived-91"]')).toBeNull();
  });

  it("caps the count at 50+", () => {
    expect(threadCountLabel(50)).toBe("50 messages");
    expect(threadCountLabel(51)).toBe("50+ messages");
    expect(threadCountLabel(1)).toBe("1 message");
    expect(threadCountLabel(0)).toBe("No messages yet");
  });

  it("marks an archived thread", () => {
    const m = makeMessage({ thread: makeThread({ archived: true }) });
    expect(render(m).querySelector('[data-testid="thread-chip-archived-91"]')).not.toBeNull();
  });

  it("opens the thread on click", () => {
    const onOpen = vi.fn();
    render(undefined, onOpen).querySelector<HTMLElement>('[data-testid="thread-chip-91"]')!.click();
    expect(onOpen).toHaveBeenCalledWith(91);
  });

  it("is plain text, not a button, without an opener", () => {
    expect(render().querySelector("button.msg-thread-chip")).toBeNull();
    expect(render().querySelector("div.msg-thread-chip")).not.toBeNull();
  });

  it("draws a thread created this session from the store, with no snapshot on the row", () => {
    upsertThread(makeThread({ starter_message_id: 1, name: "Live" }));
    expect(render(makeMessage()).textContent).toContain("Live");
  });

  it("repaints in place on a change, and drops the chip of a deleted thread", () => {
    const el = render();
    upsertThread(makeThread({ message_count: 60, name: "Bigger" }));
    refreshThreadChips(el);
    const chip = el.querySelector(".msg-thread-chip")!;
    expect(chip.textContent).toContain("Bigger");
    expect(chip.textContent).toContain("50+ messages");
    removeThread(91);
    refreshThreadChips(el);
    expect(el.querySelector(".msg-thread-chip")).toBeNull();
  });

  it("words the age", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(threadAgoLabel("2026-10-21T11:59:40Z", now)).toBe("just now");
    expect(threadAgoLabel("2026-10-21T11:57:00Z", now)).toBe("3 min ago");
    expect(threadAgoLabel("2026-10-21T07:00:00Z", now)).toBe("5 h ago");
    expect(threadAgoLabel("2026-10-19T12:00:00Z", now)).toBe("2 d ago");
  });
});
