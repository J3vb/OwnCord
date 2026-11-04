import { describe, expect, it, vi } from "vitest";
import type { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { frames, setRows, useMessageListHost } from "../helpers/browserMessageList";
import "../../src/styles/app.css";

// jsdom lays nothing out, so the editor growing inside a virtualized row, the
// height tree re-measuring and the caret staying on screen can only be checked
// in a real browser (WP 3A-8).
describe("MessageList inline editor in a real browser", () => {
  const { host, mountList } = useMessageListHost();

  async function mountReadingFromTheMiddle(): Promise<{
    list: ReturnType<typeof createMessageList>;
    root: HTMLElement;
  }> {
    const list = mountList();
    const root = host.querySelector<HTMLElement>(".messages-container")!;
    await frames(4);
    root.scrollTop = root.scrollHeight / 2;
    root.dispatchEvent(new Event("scroll"));
    // Let the rows' measured heights replace the estimates before anything is read.
    await frames(10);
    return { list, root };
  }

  /** An own, fully visible row in the lower part of the view, so growing it pushes it past the edge. */
  function lowOwnRow(root: HTMLElement): { id: number; el: HTMLElement } {
    const view = root.getBoundingClientRect();
    const rows = [...host.querySelectorAll<HTMLElement>(".virtual-content > .message")];
    const el = rows.findLast((r) => {
      const id = Number(r.dataset.testid!.replace("message-", ""));
      const box = r.getBoundingClientRect();
      return (
        id % 2 === 0 && box.top > view.top + view.height * 0.5 && box.bottom < view.bottom - 40
      );
    })!;
    return { id: Number(el.dataset.testid!.replace("message-", "")), el };
  }

  it("typing ten lines grows the row, re-measures the tree and keeps the caret in view", async () => {
    const { list, root } = await mountReadingFromTheMiddle();
    const { id, el } = lowOwnRow(root);
    const bottomSpacer = host.querySelector<HTMLElement>(".virtual-spacer-bottom")!;
    const rowHeight = el.getBoundingClientRect().height;
    const topSpacer = host.querySelector<HTMLElement>(".virtual-spacer-top")!;

    expect(list.startEdit(id)).toBe(true);
    await vi.waitFor(() =>
      expect(host.querySelector(`[data-testid="msg-edit-input-${id}"]`)).not.toBeNull(),
    );
    const textarea = host.querySelector<HTMLTextAreaElement>(
      `[data-testid="msg-edit-input-${id}"]`,
    )!;
    expect(document.activeElement).toBe(textarea);
    await frames(4);

    // Ten lines, typed at the end, as the reader would.
    textarea.value = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await frames(6);

    const grown = host.querySelector<HTMLElement>(`[data-testid="message-${id}"]`)!;
    expect(grown.getBoundingClientRect().height).toBeGreaterThan(rowHeight + 100);
    // The caret (the editor's bottom) is still inside the viewport.
    const view = root.getBoundingClientRect();
    const box = textarea.getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(view.bottom + 1);
    expect(box.top).toBeGreaterThanOrEqual(view.top - 1);
    expect(document.activeElement).toBe(textarea);

    // The height tree followed the growth: the spacers are real, the rows
    // below sit directly under the grown one (no overlap, no gap), and the
    // window the tree picked still reaches the end of the list.
    expect(parseFloat(bottomSpacer.style.height)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(topSpacer.style.height)).toBeGreaterThanOrEqual(0);
    const below = grown.nextElementSibling as HTMLElement;
    const gap = below.getBoundingClientRect().top - grown.getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(-1);
    expect(gap).toBeLessThan(40);
    root.scrollTop = root.scrollHeight;
    await frames(6);
    expect(host.querySelector('[data-testid="message-150"]')).not.toBeNull();

    list.destroy?.();
  });

  it("the selection and focus survive a patchRows move of the edited row", async () => {
    const { list, root } = await mountReadingFromTheMiddle();
    const { id, el } = lowOwnRow(root);
    expect(list.startEdit(id)).toBe(true);
    await vi.waitFor(() =>
      expect(host.querySelector(`[data-testid="msg-edit-input-${id}"]`)).not.toBeNull(),
    );
    const textarea = host.querySelector<HTMLTextAreaElement>(
      `[data-testid="msg-edit-input-${id}"]`,
    )!;
    textarea.value = "a half typed edit that is long enough";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(7, 17);
    await frames(4);
    const rowBefore = host.querySelector(`[data-testid="message-${id}"]`)!;
    // Opening the editor drew the row again, so the row from before is gone.
    expect(el.isConnected).toBe(false);
    expect(rowBefore.contains(textarea)).toBe(true);

    // A reaction lands: the row is drawn again around the same textarea.
    const current = messagesStore.getState().messagesByChannel.get(1)!;
    setRows(
      current.map((m) =>
        m.id === id ? { ...m, reactions: [{ emoji: "🔥", count: 2, me: false }] } : m,
      ),
    );
    await messagesStore.flush();
    await frames(4);

    const rowAfter = host.querySelector<HTMLElement>(`[data-testid="message-${id}"]`)!;
    expect(rowAfter).not.toBe(rowBefore);
    expect(rowAfter.querySelector(".reaction-chip")).not.toBeNull();
    expect(host.querySelector(`[data-testid="msg-edit-input-${id}"]`)).toBe(textarea);
    expect(rowAfter.contains(textarea)).toBe(true);
    expect(textarea.value).toBe("a half typed edit that is long enough");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 17]);
    expect(document.activeElement).toBe(textarea);

    list.destroy?.();
  });
  it("bringing the edited row into view is not a jump: growing the editor does not re-centre the row", async () => {
    const { list, root } = await mountReadingFromTheMiddle();
    // Nudge the view until an own row straddles the bottom edge, so opening
    // its editor has to scroll it in.
    const view = root.getBoundingClientRect();
    const straddling = (): HTMLElement | undefined =>
      [...host.querySelectorAll<HTMLElement>(".virtual-content > .message")].find((r) => {
        const id = Number(r.dataset.testid!.replace("message-", ""));
        const box = r.getBoundingClientRect();
        return id % 2 === 0 && box.top < view.bottom - 10 && box.bottom > view.bottom + 10;
      });
    for (let i = 0; i < 80 && straddling() === undefined; i++) {
      root.scrollTop += 7;
      root.dispatchEvent(new Event("scroll"));
      await frames(2);
    }
    const target = straddling()!;
    const id = Number(target.dataset.testid!.replace("message-", ""));

    expect(list.startEdit(id)).toBe(true);
    await vi.waitFor(() =>
      expect(host.querySelector(`[data-testid="msg-edit-input-${id}"]`)).not.toBeNull(),
    );
    await frames(6);
    const textarea = host.querySelector<HTMLTextAreaElement>(
      `[data-testid="msg-edit-input-${id}"]`,
    )!;
    const before = root.scrollTop;

    // Five more lines, well inside the view: nothing needs to scroll.
    textarea.value = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await frames(8);

    expect(root.scrollTop).toBe(before);
    list.destroy?.();
  });
});
