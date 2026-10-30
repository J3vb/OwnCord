import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageActionGates } from "../../src/components/message-list/messageActions";
import { createMessageInput } from "../../src/components/MessageInput";
import type { PollView } from "../../src/lib/types";
import {
  applyReadyCapabilities,
  pollsEnabled,
  resetServerCapabilities,
} from "@lib/net/serverCapabilities";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";

const poll: PollView = {
  question: "Lunch?",
  answers: [
    { answer_id: 1, text: "Pizza", emoji: null },
    { answer_id: 2, text: "Sushi", emoji: null },
  ],
  allow_multiselect: false,
  expires_at: "2099-01-01T00:00:00Z",
  ended: false,
  ended_at: null,
  results: { version: 0, total_voters: 0, counts: [], me: [] },
  selfVersion: 0,
};

describe("a poll message's gates", () => {
  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel();
  });
  afterEach(() => resetGateStores());

  it("my own poll cannot be edited, though I can delete it", () => {
    const g = messageActionGates(
      makeMessage({ user: { id: ME, username: "me", avatar: null }, poll }),
      makeOpts(),
    );
    expect(g.edit.shown).toBe(false);
    expect(g.delete.shown).toBe(true);
    // The same message without a poll is editable, so the poll is what removed it.
    const plain = makeMessage({ user: { id: ME, username: "me", avatar: null } });
    expect(messageActionGates(plain, makeOpts()).edit.shown).toBe(true);
  });

  it("a poll cannot be forwarded, but reply, react, pin and report are as on any message", () => {
    const opts = makeOpts({ onForwardClick: vi.fn(), onReportClick: vi.fn() });
    const g = messageActionGates(
      makeMessage({ user: { id: OTHER, username: "alice", avatar: null }, poll }),
      opts,
    );
    expect(g.forward.shown).toBe(false);
    expect(g.react.shown).toBe(true);
    expect(g.report.shown).toBe(true);
    const plain = messageActionGates(
      makeMessage({ user: { id: OTHER, username: "alice", avatar: null } }),
      opts,
    );
    expect(plain.forward.shown).toBe(true);
  });
});

describe("the composer's Poll button", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    resetServerCapabilities();
  });

  const mount = (onCreatePoll?: () => void) => {
    const comp = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      ...(onCreatePoll === undefined ? {} : { onCreatePoll }),
    });
    comp.mount(container);
    return comp;
  };
  const button = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('[data-testid="poll-btn"]');

  it("is hidden on a server that does not advertise polls", () => {
    applyReadyCapabilities({ read_pointer: true });
    expect(pollsEnabled()).toBe(false);
    const comp = mount(vi.fn());
    expect(button()).toBeNull();
    comp.destroy?.();
  });

  it("is hidden before any ready has arrived", () => {
    const comp = mount(vi.fn());
    expect(button()).toBeNull();
    comp.destroy?.();
  });

  it("is hidden when the host gives no dialog to open", () => {
    applyReadyCapabilities({ polls: true });
    const comp = mount();
    expect(button()).toBeNull();
    comp.destroy?.();
  });

  it("is shown beside GIF with the capability and opens the dialog", () => {
    applyReadyCapabilities({ polls: true });
    const open = vi.fn();
    const comp = mount(open);
    const btn = button()!;
    expect(btn).not.toBeNull();
    expect(btn.previousElementSibling?.classList.contains("gif-btn")).toBe(true);
    btn.click();
    expect(open).toHaveBeenCalledTimes(1);
    comp.destroy?.();
  });

  it("is disabled with the rest of the composer when it is gated", () => {
    applyReadyCapabilities({ polls: true });
    const comp = mount(vi.fn());
    comp.setDisabled?.("You can't send here");
    expect(button()!.disabled).toBe(true);
    comp.setDisabled?.(null);
    expect(button()!.disabled).toBe(false);
    comp.destroy?.();
  });
});
