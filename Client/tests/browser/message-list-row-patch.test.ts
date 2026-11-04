import { describe, expect, it } from "vitest";
import { messagesStore } from "@stores/messages.store";
import { frames, setRows, useMessageListHost } from "../helpers/browserMessageList";
import "../../src/styles/app.css";

// jsdom lays nothing out, so a row growing, the scroll anchor and the spacers
// can only be checked in a real browser (P4-01).
describe("MessageList row patch in a real browser", () => {
  const { host, mountList } = useMessageListHost();

  it("grows an edited row in place, holds the scroll anchor and keeps the bottom spacer", async () => {
    const list = mountList();
    const root = host.querySelector<HTMLElement>(".messages-container")!;
    const bottomSpacer = host.querySelector<HTMLElement>(".virtual-spacer-bottom")!;
    await frames(3);

    // Read from the middle of the channel, away from both ends.
    root.scrollTop = root.scrollHeight / 2;
    root.dispatchEvent(new Event("scroll"));
    await frames(3);

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
    await frames(3);
    const settled = host.querySelector(`[data-testid="${anchor.dataset.testid}"]`)!;
    expect(Math.abs(settled.getBoundingClientRect().top - anchorTop)).toBeLessThanOrEqual(1);

    list.destroy?.();
  });
});
