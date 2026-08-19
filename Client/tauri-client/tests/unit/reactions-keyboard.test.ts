/**
 * Keyboard activation for reaction pills (OC-0186).
 *
 * The chip carries tabindex="0" so it is reachable via Tab, but a bare
 * <span> has no native key activation. Enter/Space on a focused pill must
 * mirror the click, and the "+" add-reaction chip must be reachable and
 * activatable the same way.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

import { renderReactions } from "../../src/components/message-list/reactions";
import type { Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";

function makeMessage(): Message {
  return {
    id: 1,
    channelId: 1,
    userId: 10,
    username: "alice",
    avatar: null,
    content: "hi",
    timestamp: "2026-01-01T00:00:00Z",
    editedAt: null,
    replyTo: null,
    attachments: [],
    reactions: [{ emoji: "🔥", count: 2, me: false }],
    pending: false,
    failed: false,
    pinned: false,
  } as unknown as Message;
}

function reactionOptions(): MessageListOptions {
  return { onReactionClick: vi.fn() } as unknown as MessageListOptions;
}

function fireKey(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("reaction pill keyboard activation (OC-0186)", () => {
  it("toggles the reaction on Enter when the pill is focused", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeMessage(), opts, new AbortController().signal);
    const chip = el.querySelector(".reaction-chip") as HTMLElement;
    fireKey(chip, "Enter");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "🔥");
  });

  it("toggles the reaction on Space when the pill is focused", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeMessage(), opts, new AbortController().signal);
    const chip = el.querySelector(".reaction-chip") as HTMLElement;
    fireKey(chip, " ");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "🔥");
  });

  it("advertises button semantics on the reaction pill", () => {
    const el = renderReactions(makeMessage(), reactionOptions(), new AbortController().signal);
    const chip = el.querySelector(".reaction-chip");
    expect(chip?.getAttribute("role")).toBe("button");
  });

  it("makes the add-reaction chip focusable and keyboard-activatable", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeMessage(), opts, new AbortController().signal);
    const addBtn = el.querySelector(".add-reaction") as HTMLElement;
    expect(addBtn.getAttribute("tabindex")).toBe("0");
    expect(addBtn.getAttribute("role")).toBe("button");
    fireKey(addBtn, "Enter");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "");
  });
});
