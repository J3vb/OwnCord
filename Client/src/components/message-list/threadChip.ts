/**
 * The chip under a thread's starter message (WP 6.9c): the thread's name, how
 * many messages it holds ("50+" past the cap), when it last had one, and an
 * archive mark. A click opens the thread's side panel.
 *
 * The chip draws from `threadOfMessage`, so a live `thread_changed` outranks
 * the snapshot on the row. Because a count changes far more often than a row is
 * rebuilt, `refreshThreadChips` repaints the chips already on screen in place
 * (and drops one whose thread was deleted) instead of re-rendering the list.
 */

import { createElement } from "@lib/dom";
import { parseTimestamp } from "@lib/formatting";
import { createIcon } from "@lib/icons";
import type { ThreadInfo } from "@lib/types";
import { threadOfMessage, threadsStore } from "@stores/threads.store";
import { messagingText } from "../../i18n/messaging";

function shape(tag: "rect" | "path", attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/** The archive box (Lucide). Kept here, in the lazy chunk, not in the startup icon table. */
export function createArchiveIcon(size: number): SVGSVGElement {
  const svg = createIcon("x", size);
  svg.replaceChildren(
    shape("rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }),
    shape("path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }),
    shape("path", { d: "M10 12h4" }),
  );
  return svg;
}

/** A thread shows its exact count up to this many, then "50+". */
export const THREAD_COUNT_CAP = 50;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "No messages yet", "1 message", "12 messages", "50+ messages". */
export function threadCountLabel(count: number): string {
  if (count <= 0) return messagingText("thread.noMessages");
  if (count > THREAD_COUNT_CAP) {
    return messagingText("thread.countCapped", { count: THREAD_COUNT_CAP });
  }
  return messagingText("thread.count", { count });
}

/** "just now", "3 min ago", "5 h ago", "2 d ago". */
export function threadAgoLabel(iso: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - parseTimestamp(iso).getTime());
  if (elapsed < MINUTE_MS) return messagingText("thread.ago.now");
  if (elapsed < HOUR_MS) {
    return messagingText("thread.ago.minutes", { count: Math.floor(elapsed / MINUTE_MS) });
  }
  if (elapsed < DAY_MS) {
    return messagingText("thread.ago.hours", { count: Math.floor(elapsed / HOUR_MS) });
  }
  return messagingText("thread.ago.days", { count: Math.floor(elapsed / DAY_MS) });
}

/** The chip's text parts, rebuilt from the thread's state. */
function fill(chip: HTMLElement, thread: ThreadInfo): void {
  chip.classList.toggle("archived", thread.archived);
  chip.setAttribute("aria-label", messagingText("thread.open", { name: thread.name }));
  const when = thread.last_message_at ?? thread.created_at;
  chip.replaceChildren(
    createIcon("message-square", 14),
    createElement("span", { class: "msg-thread-name" }, thread.name),
    createElement("span", { class: "msg-thread-count" }, threadCountLabel(thread.message_count)),
    createElement("span", { class: "msg-thread-ago" }, threadAgoLabel(when)),
  );
  if (thread.archived) {
    const mark = createElement("span", {
      class: "msg-thread-archived",
      title: messagingText("thread.archived"),
      "data-testid": `thread-chip-archived-${thread.id}`,
    });
    mark.appendChild(createArchiveIcon(14));
    chip.appendChild(mark);
  }
}

/** The chip for `thread`; a button when `onOpen` is given, else plain text. */
export function renderThreadChip(
  thread: ThreadInfo,
  onOpen: ((threadId: number) => void) | undefined,
  signal: AbortSignal,
): HTMLElement {
  const attrs = {
    class: "msg-thread-chip",
    "data-thread-id": String(thread.id),
    "data-testid": `thread-chip-${thread.id}`,
  };
  const chip =
    onOpen === undefined
      ? createElement("div", attrs)
      : createElement("button", { ...attrs, type: "button" });
  fill(chip, thread);
  if (onOpen !== undefined) {
    chip.addEventListener("click", () => onOpen(thread.id), { signal });
  }
  return chip;
}

/** How to draw a chip a row does not have yet: for a thread created after the row rendered. */
export interface ThreadChipAdd {
  readonly messages: readonly { readonly id: number; readonly thread?: ThreadInfo }[];
  readonly onOpen: ((threadId: number) => void) | undefined;
  readonly signal: AbortSignal;
}

/**
 * Repaint the chips under `container` from the store and remove a deleted
 * thread's. With `add`, a rendered starter row that has no chip yet (its
 * thread was created, or recreated after a delete, since it rendered) gets one.
 */
export function refreshThreadChips(container: ParentNode, add?: ThreadChipAdd): void {
  const { byId, deleted } = threadsStore.getState();
  for (const chip of container.querySelectorAll<HTMLElement>(".msg-thread-chip")) {
    const id = Number(chip.dataset["threadId"]);
    if (deleted.has(id)) {
      chip.remove();
      continue;
    }
    const thread = byId.get(id);
    if (thread !== undefined) fill(chip, thread);
  }
  if (add === undefined) return;
  for (const msg of add.messages) {
    const thread = threadOfMessage(msg);
    if (thread === undefined) continue;
    const row = container.querySelector<HTMLElement>(`[data-testid="message-${msg.id}"]`);
    if (row === null || row.querySelector(".msg-thread-chip") !== null) continue;
    const chip = renderThreadChip(thread, add.onOpen, add.signal);
    row.insertBefore(chip, row.querySelector(":scope > .msg-reactions"));
  }
}
