import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import "../../src/styles/app.css";

// jsdom lays nothing out, so a row growing, the scroll anchor and the spacers
// can only be checked in a real browser (P4-01).
function message(id: number): Message {
  return {
    id,
    channelId: 1,
    user: { id: (id % 2) + 1, username: id % 2 === 0 ? "Alice" : "Bob", avatar: null },
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, id)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

function setRows(rows: readonly Message[]): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map([[1, rows]]),
    hasMore: new Map([[1, false]]),
  }));
}

const frames = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
};

describe("MessageList row patch in a real browser", () => {
  const style = document.createElement("style");
  style.textContent = ".messages-region { height: 400px; display: flex; flex-direction: column; }";
  const host = document.createElement("div");

  afterEach(() => {
    host.replaceChildren();
    style.remove();
    host.remove();
  });

  it("grows an edited row in place, holds the scroll anchor and keeps the bottom spacer", async () => {
    document.head.appendChild(style);
    document.body.appendChild(host);
    setRows(Array.from({ length: 150 }, (_, i) => message(i + 1)));
    const list = createMessageList({
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    });
    list.mount(host);
    const root = host.querySelector<HTMLElement>(".messages-container")!;
    const bottomSpacer = host.querySelector<HTMLElement>(".virtual-spacer-bottom")!;
    await frames();

    // Read from the middle of the channel, away from both ends.
    root.scrollTop = root.scrollHeight / 2;
    root.dispatchEvent(new Event("scroll"));
    await frames();

    const top = root.getBoundingClientRect().top;
    const rows = [...host.querySelectorAll<HTMLElement>(".virtual-content > .message")];
    const anchor = rows.find((el) => el.getBoundingClientRect().top >= top)!;
    // The edited row is rendered but above the viewport, so its growth would
    // push the row being read down unless the anchor is restored.
    const edited = rows.findLast((el) => el.getBoundingClientRect().bottom < top)!;
    const editedId = Number(edited.dataset.testid!.replace("message-", ""));
    const anchorTop = anchor.getBoundingClientRect().top;
    const editedHeight = edited.getBoundingClientRect().height;
    const bottomBefore = bottomSpacer.style.height;

    const current = messagesStore.getState().messagesByChannel.get(1)!;
    setRows(
      current.map((m) =>
        m.id === editedId ? { ...m, content: "first line\nsecond line\nthird line" } : m,
      ),
    );
    await messagesStore.flush();

    // The patch itself: only the edited row is new, and it grew.
    const grown = host.querySelector<HTMLElement>(`[data-testid="message-${editedId}"]`)!;
    expect(grown).not.toBe(edited);
    expect(grown.getBoundingClientRect().height).toBeGreaterThan(editedHeight);
    expect(host.querySelector(`[data-testid="${anchor.dataset.testid}"]`)).toBe(anchor);
    expect(Math.abs(anchor.getBoundingClientRect().top - anchorTop)).toBeLessThanOrEqual(1);
    // Nothing below the window changed, so neither did the space it stands for.
    expect(bottomSpacer.style.height).toBe(bottomBefore);

    // The row being read stays put once layout and any window move settle.
    await frames();
    const settled = host.querySelector(`[data-testid="${anchor.dataset.testid}"]`)!;
    expect(Math.abs(settled.getBoundingClientRect().top - anchorTop)).toBeLessThanOrEqual(1);

    list.destroy?.();
  });
});
