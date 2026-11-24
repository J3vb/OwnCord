/**
 * The Command Deck's Direct button: one count of unread DMs plus waiting
 * message requests, and a click that takes focus to the Direct folder header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectButton } from "../../../src/features/direct-messages/directButton";
import { DIRECT_HEAD_CLASS } from "../../../src/features/direct-messages/dmFolder";
import {
  applyFrame,
  messageRequestsStore,
  resetMessageRequests,
} from "../../../src/features/message-requests/store";
import type { MessageRequest } from "../../../src/features/message-requests/api";
import { dmStore, setDmChannels, type DmChannel } from "../../../src/stores/dm.store";
import { Disposable } from "@lib/disposable";
import {
  CHANNEL_MUTE_CHANGED,
  invalidateMuteCache,
  muteChannel,
  unmuteChannel,
} from "@lib/prefs/channelMutes";
import { dmRecipient, makeDm, resetDmAndUiState } from "../../helpers/dmHarness";

/** A DM with `unread` messages, `mentions` of them mentions. */
function dm(channelId: number, unread: number, mentions = 0): DmChannel {
  const user = dmRecipient(channelId, `u${channelId}`);
  return makeDm({
    channelId,
    recipient: user,
    participants: [user],
    unreadCount: unread,
    mentionCount: mentions,
  });
}

/** A waiting request from sender `id`; only its id and channel matter to the count. */
const request = (id: number): MessageRequest => ({
  id,
  channelId: 300 + id,
  sender: { id: 40 + id, username: `sender${id}`, displayName: "" },
  preview: null,
  createdAt: "2026-11-20T09:00:00Z",
});

function setDms(...channels: DmChannel[]): void {
  setDmChannels(channels);
  dmStore.flush();
}

function addRequests(...ids: number[]): void {
  for (const id of ids) applyFrame(request(id), true);
  messageRequestsStore.flush();
}

let root: HTMLDivElement;
let owner: Disposable;

function build(revealSidebar?: () => void): HTMLButtonElement {
  const button = createDirectButton({ root, revealSidebar, owner });
  document.body.appendChild(button);
  return button;
}

const badgeOf = (button: HTMLElement): HTMLElement =>
  button.querySelector<HTMLElement>(".deck-direct-badge")!;

/** A focusable Direct folder header, optionally inside an inert sidebar. */
function addHeader(inert: boolean): HTMLElement {
  const sidebar = document.createElement("div");
  if (inert) sidebar.setAttribute("inert", "");
  const head = document.createElement("div");
  head.className = DIRECT_HEAD_CLASS;
  head.tabIndex = -1;
  sidebar.appendChild(head);
  root.appendChild(sidebar);
  return head;
}

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
  resetDmAndUiState();
  resetMessageRequests();
  messageRequestsStore.flush();
  root = document.createElement("div");
  document.body.appendChild(root);
  owner = new Disposable();
});

afterEach(() => {
  owner.destroy();
  document.body.replaceChildren();
});

describe("createDirectButton", () => {
  it("count is unread plus requests and hidden at zero", () => {
    const button = build();
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.className).toBe("deck-direct");
    expect(button.dataset["testid"]).toBe("deck-direct");
    expect(button.title).toBe("Direct messages");
    expect(button.querySelector('[data-icon="mail"]')).not.toBeNull();
    const badge = badgeOf(button);
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe("");

    setDms(dm(1, 2), dm(2, 3));
    addRequests(1);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("6");

    setDms(dm(1, 0));
    resetMessageRequests();
    messageRequestsStore.flush();
    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe("");
  });

  it("the name tells unread and requests apart", () => {
    const button = build();
    const name = (): string | null => button.getAttribute("aria-label");
    expect(name()).toBe("Direct messages");
    setDms(dm(1, 1));
    expect(name()).toBe("Direct messages, 1 unread");
    setDms(dm(1, 4));
    expect(name()).toBe("Direct messages, 4 unread");
    setDms();
    addRequests(1);
    expect(name()).toBe("Direct messages, 1 message request waiting");
    addRequests(2);
    expect(name()).toBe("Direct messages, 2 message requests waiting");
    setDms(dm(1, 3));
    expect(name()).toBe("Direct messages, 3 unread, 2 message requests waiting");
    resetMessageRequests();
    addRequests(5);
    expect(name()).toBe("Direct messages, 3 unread, 1 message request waiting");
  });

  it("follows the DM store and the request count", () => {
    const button = build();
    const badge = badgeOf(button);
    setDms(dm(1, 2));
    expect(badge.textContent).toBe("2");
    addRequests(1, 2);
    expect(badge.textContent).toBe("4");
    applyFrame(request(1), false);
    messageRequestsStore.flush();
    expect(badge.textContent).toBe("3");
    setDms(dm(1, 120));
    expect(badge.textContent).toBe("99+");
  });

  it("muting a DM with unread messages lowers the count on CHANNEL_MUTE_CHANGED", () => {
    setDms(dm(1, 5, 1), dm(2, 2));
    const button = build();
    const badge = badgeOf(button);
    expect(badge.textContent).toBe("7");
    muteChannel(1);
    expect(badge.textContent).toBe("3");
    expect(button.getAttribute("aria-label")).toBe("Direct messages, 3 unread");
    unmuteChannel(1);
    expect(badge.textContent).toBe("7");
  });

  it("a click focuses the button, then the Direct header", () => {
    const head = addHeader(false);
    const reveal = vi.fn();
    const button = build(reveal);
    const focused: Element[] = [];
    button.addEventListener("focus", () => focused.push(button));
    head.addEventListener("focus", () => focused.push(head));
    button.click();
    expect(focused).toEqual([button, head]);
    expect(document.activeElement).toBe(head);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("a click with the header inside an inert sidebar reveals it first, then focuses", () => {
    const head = addHeader(true);
    const sidebar = head.parentElement!;
    const order: string[] = [];
    const reveal = vi.fn(() => {
      order.push("reveal");
      sidebar.removeAttribute("inert");
    });
    head.addEventListener("focus", () => order.push("head"));
    const button = build(reveal);
    button.click();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reveal", "head"]);
    expect(document.activeElement).toBe(head);
  });

  it("no header: the click does nothing and throws nothing", () => {
    const reveal = vi.fn();
    const button = build(reveal);
    expect(() => button.click()).not.toThrow();
    expect(reveal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    // An inert header with no drawer to open: nothing throws.
    addHeader(true);
    const bare = build(undefined);
    expect(() => bare.click()).not.toThrow();
  });

  it("owner.destroy removes all three subscriptions", () => {
    setDms(dm(1, 5, 1));
    const button = build();
    const badge = badgeOf(button);
    expect(badge.textContent).toBe("5");
    owner.destroy();

    setDms(dm(1, 9, 1));
    addRequests(1);
    expect(badge.textContent).toBe("5");
    // Muted while detached from the stores: a dispatched event no longer redraws.
    setDmChannels([dm(1, 5, 1)]);
    muteChannel(1);
    window.dispatchEvent(new CustomEvent(CHANNEL_MUTE_CHANGED, { detail: { channelId: 1 } }));
    expect(badge.textContent).toBe("5");
    expect(button.getAttribute("aria-label")).toBe("Direct messages, 5 unread");
  });
});
