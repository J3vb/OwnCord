import { expect } from "vitest";
import { messagesStore, type Message } from "@stores/messages.store";
import type { messageActionGates } from "@components/message-list/messageActions";

type Gates = ReturnType<typeof messageActionGates>;

/** Puts exactly `rows` in channel 1 of the messages store. */
export function seedChannelOneRows(rows: readonly Message[]): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map([[1, [...rows]]]),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
}

/** Whether each of react, edit, pin, delete and report is offered. */
export function shownActions(gates: Gates): boolean[] {
  return [gates.react, gates.edit, gates.pin, gates.delete, gates.report].map((x) => x.shown);
}

export function messageMenuNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.message-context-menu [role="menuitem"]')].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent ?? "",
  );
}

export function openRowMenu(row: HTMLElement): void {
  row.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
  );
}

/** Right-clicks `row` and asserts no message menu ever appears. */
export async function expectNoRowMenu(row: HTMLElement): Promise<void> {
  openRowMenu(row);
  await import("@components/message-list/messageMenu");
  await new Promise((r) => setTimeout(r, 0));
  expect(document.querySelector(".message-context-menu")).toBeNull();
}
