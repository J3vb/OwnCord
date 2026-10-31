/**
 * Keyboard activation for reaction pills (OC-0186).
 *
 * The chip carries tabindex="0" so it is reachable via Tab, but a bare
 * <span> has no native key activation. Enter/Space on a focused pill must
 * mirror the click, and the "+" add-reaction chip must be reachable and
 * activatable the same way.
 */

import { makeReactionMessage, reactionOptions } from "../helpers/reactionFixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

import { refreshReactionLocks, renderReactions } from "../../src/components/message-list/reactions";
import { setConnectionStatus, uiStore } from "@stores/ui.store";

// Reaction controls lock while the socket is down (3A-3); these tests react online.
beforeEach(() => {
  setConnectionStatus("connected");
  uiStore.flush();
});

function fireKey(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("reaction pill keyboard activation", () => {
  it("toggles the reaction on Enter when the pill is focused", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeReactionMessage(), opts, new AbortController().signal);
    const chip = el.querySelector(".reaction-chip") as HTMLElement;
    fireKey(chip, "Enter");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "🔥");
  });

  it("toggles the reaction on Space when the pill is focused", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeReactionMessage(), opts, new AbortController().signal);
    const chip = el.querySelector(".reaction-chip") as HTMLElement;
    fireKey(chip, " ");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "🔥");
  });

  it("advertises button semantics on the reaction pill", () => {
    const el = renderReactions(
      makeReactionMessage(),
      reactionOptions(),
      new AbortController().signal,
    );
    const chip = el.querySelector(".reaction-chip");
    expect(chip?.getAttribute("role")).toBe("button");
  });

  it("makes the add-reaction chip focusable and keyboard-activatable", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeReactionMessage(), opts, new AbortController().signal);
    const addBtn = el.querySelector(".add-reaction") as HTMLElement;
    expect(addBtn.getAttribute("tabindex")).toBe("0");
    expect(addBtn.getAttribute("role")).toBe("button");
    fireKey(addBtn, "Enter");
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "");
  });
});

describe("reactions while offline (3A-3)", () => {
  it("locks pills and the add chip while the socket is down, and unlocks on reconnect", () => {
    setConnectionStatus("disconnected");
    uiStore.flush();
    const opts = reactionOptions();
    const el = renderReactions(makeReactionMessage(), opts, new AbortController().signal);
    const chip = el.querySelector(".reaction-chip") as HTMLElement;
    const add = el.querySelector(".add-reaction") as HTMLElement;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.title).toBe("Not connected");
    chip.click();
    fireKey(add, "Enter");
    expect(opts.onReactionClick).not.toHaveBeenCalled();

    setConnectionStatus("connected");
    uiStore.flush();
    refreshReactionLocks(el, makeReactionMessage().channelId);
    expect(chip.hasAttribute("aria-disabled")).toBe(false);
    chip.click();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, "🔥");
  });
});
