import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMessageList } from "@components/MessageList";
import { messagesStore, type Message } from "@stores/messages.store";
import {
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

function seed(messages: Message[]): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map([[1, messages]]),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
}

/** The clock alone: "2:34 PM" or "14:34", nothing before or after it. */
const CLOCK_ONLY = /^\d{1,2}:\d{2}( [AP]M)?$/;

describe("message header time on a phone", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let phone = false;

  const time = (): HTMLElement => container.querySelector<HTMLElement>(".msg-time")!;

  function mount(timestamp: string): void {
    seed([makeMessage({ timestamp })]);
    list = createMessageList(makeOpts());
    list.mount(container);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 18, 34, 0));
    phone = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: phone && q.includes("pointer: coarse") })),
    );
    resetGateStores();
    localStorage.clear();
    signInAs("member");
    setChannel();
    resetMembersState();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    resetGateStores();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the day word and date off a desktop", () => {
    mount(new Date(2024, 0, 15, 9, 5, 0).toISOString());
    expect(time().textContent).toMatch(/^Today at /);
  });

  it("shows the clock alone for a message from today", () => {
    phone = true;
    mount(new Date(2024, 0, 15, 9, 5, 0).toISOString());
    expect(time().textContent).toMatch(CLOCK_ONLY);
    expect(time().textContent).toContain("9:05");
  });

  it("shows the clock alone for an older message, with no date in the row", () => {
    phone = true;
    mount(new Date(2023, 10, 2, 14, 5, 0).toISOString());
    expect(time().textContent).toMatch(CLOCK_ONLY);
    expect(time().textContent).not.toContain("2023");
  });

  it("follows the 24-hour clock setting", () => {
    phone = true;
    localStorage.setItem("owncord:settings:timeFormat", JSON.stringify("24h"));
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
    mount(new Date(2024, 0, 15, 14, 5, 0).toISOString());
    expect(time().textContent).toBe("14:05");
  });

  it("keeps the full date and weekday in the title, so nothing is lost", () => {
    phone = true;
    mount(new Date(2023, 10, 2, 14, 5, 0).toISOString());
    const title = time().title;
    expect(title).toContain("2023");
    expect(title).toContain("November");
    expect(title).toContain("Thursday");
  });

  it("redraws the rendered rows when a rotation moves the window onto and off the phone layout", () => {
    mount(new Date(2024, 0, 15, 9, 5, 0).toISOString());
    expect(time().textContent).toMatch(/^Today at /);

    phone = true;
    window.dispatchEvent(new Event("resize"));
    expect(time().textContent).toMatch(CLOCK_ONLY);
    expect(time().title).toContain("2024");

    phone = false;
    window.dispatchEvent(new Event("resize"));
    expect(time().textContent).toMatch(/^Today at /);
  });
});
