// The moderation notices banner: its markup, which notice a click acts on,
// focus when a row leaves, and what happens after the page is torn down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stores/ui.store", () => ({ openSettings: vi.fn() }));

import { ApiClientError } from "../../lib/api";
import { formatWhen } from "../../i18n/safety";
import { openSettings } from "@stores/ui.store";
import { createNoticesBanner } from "./Notices";
import { removeNotice, resetSafetyStore, safetyStore, setReadyNotices } from "./store";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function notice(id: number, createdAt = `2026-09-0${id}T10:00:00Z`) {
  return { id, kind: "warning" as const, reason: `r${id}`, created_at: createdAt };
}

interface Mounted {
  readonly el: HTMLElement;
  readonly ac: AbortController;
  readonly fallback: ReturnType<typeof vi.fn>;
  readonly getOwnModeration: ReturnType<typeof vi.fn>;
}

function mount(acknowledgeNotice: (id: number, signal?: AbortSignal) => Promise<void>): Mounted {
  const ac = new AbortController();
  const fallback = vi.fn();
  const getOwnModeration = vi.fn().mockResolvedValue([]);
  const el = createNoticesBanner({
    api: { acknowledgeNotice, getOwnModeration, fileAppeal: vi.fn(), withdrawAppeal: vi.fn() },
    fallbackFocus: fallback,
    signal: ac.signal,
  });
  document.body.appendChild(el);
  return { el, ac, fallback, getOwnModeration };
}

const ackButtons = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>("[data-testid='moderation-notice-ack']"),
];
const noticeEl = (el: HTMLElement, id: number): HTMLElement =>
  el.querySelector<HTMLElement>(`[data-testid='moderation-notice-${id}']`)!;
const statusOf = (el: HTMLElement, id: number): HTMLElement =>
  noticeEl(el, id).querySelector<HTMLElement>(".moderation-notice-status")!;

beforeEach(() => {
  resetSafetyStore();
  vi.mocked(openSettings).mockClear();
});
afterEach(() => {
  resetSafetyStore();
  document.body.replaceChildren();
});

describe("notices banner markup", () => {
  it("builds the banner, list and announcer with their classes and roles", async () => {
    const { el, ac } = mount(vi.fn());
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toBe("moderation-notices");
    expect(el.dataset["testid"]).toBe("moderation-notices");
    expect(el.querySelector(":scope > .moderation-notices-list")).not.toBeNull();
    const announcer = el.querySelector(":scope > .sr-only")!;
    expect(announcer.getAttribute("role")).toBe("status");
    ac.abort();
  });

  it("builds each notice with a labelled title, date, reason and two actions", async () => {
    const { el, ac } = mount(vi.fn());
    setReadyNotices([notice(1)]);
    await flush();
    const row = noticeEl(el, 1);
    expect(row.className).toBe("moderation-notice");
    expect(row.getAttribute("role")).toBe("group");
    const title = row.querySelector<HTMLElement>(".moderation-notice-title")!;
    expect(title.id).toBe("moderation-notice-1-title");
    expect(row.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.querySelector("strong")!.textContent).toBe("Warning from the moderators");
    const issued = `Issued ${formatWhen("2026-09-01T10:00:00Z")}`;
    expect(title.querySelector(".moderation-notice-date")!.textContent).toBe(issued);
    expect(title.textContent).toBe(`Warning from the moderators ${issued}`);
    expect(row.querySelector(".moderation-notice-reason")!.textContent).toBe("Reason: r1");
    const actions = row.querySelector(".moderation-notice-actions")!;
    const ack = actions.querySelector<HTMLButtonElement>(".ac-btn.moderation-notice-ack")!;
    const view = actions.querySelector<HTMLButtonElement>("button.moderation-notice-link")!;
    expect(ack.type).toBe("button");
    expect(view.type).toBe("button");
    expect(view.textContent).toBe("View in Privacy & Safety settings");
    expect(row.querySelector(".moderation-notice-status")!.getAttribute("role")).toBe("status");
    ac.abort();
  });

  it("shows notices that were already in the store when it mounts", async () => {
    setReadyNotices([notice(1), notice(2)]);
    await flush();
    const { el, ac } = mount(vi.fn());
    expect(el.classList.contains("visible")).toBe(true);
    expect(ackButtons(el)).toHaveLength(2);
    ac.abort();
  });
});

describe("acknowledging", () => {
  it("acts on the notice whose button was pressed", async () => {
    const acknowledgeNotice = vi.fn().mockResolvedValue(undefined);
    const { el, ac, getOwnModeration } = mount(acknowledgeNotice);
    setReadyNotices([notice(1), notice(2)]);
    await flush();
    ackButtons(el)[1]!.click();
    await flush();
    expect(acknowledgeNotice).toHaveBeenCalledTimes(1);
    expect(acknowledgeNotice).toHaveBeenCalledWith(2, ac.signal);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([1]);
    // The history is re-read once the server confirmed.
    expect(getOwnModeration).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("sends nothing for a notice that is no longer listed", async () => {
    const acknowledgeNotice = vi.fn().mockResolvedValue(undefined);
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([notice(1)]);
    await flush();
    const button = ackButtons(el)[0]!;
    removeNotice(1);
    button.click();
    await flush();
    expect(acknowledgeNotice).not.toHaveBeenCalled();
    ac.abort();
  });

  it("clears the error and the busy state once a retry is under way and once it fails again", async () => {
    let attempt = 0;
    let release!: () => void;
    const acknowledgeNotice = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new ApiClientError(500, "INTERNAL", "boom"));
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([notice(1)]);
    await flush();
    const button = ackButtons(el)[0]!;
    expect(statusOf(el, 1).textContent).toBe("");
    expect(statusOf(el, 1).classList.contains("form-error")).toBe(false);

    button.click();
    await flush();
    expect(statusOf(el, 1).textContent).toBe("Your acknowledgement wasn't recorded. Try again.");
    expect(statusOf(el, 1).classList.contains("form-error")).toBe(true);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.textContent).toBe("Acknowledge");

    button.click();
    await flush();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(statusOf(el, 1).textContent).toBe("");
    expect(statusOf(el, 1).classList.contains("form-error")).toBe(false);
    release();
    await flush();
    ac.abort();
  });

  it("sends a second notice while the first is still being acknowledged", async () => {
    const acknowledgeNotice = vi.fn(() => new Promise<void>(() => {}));
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([notice(1), notice(2)]);
    await flush();
    ackButtons(el)[0]!.click();
    await flush();
    ackButtons(el)[1]!.click();
    await flush();
    expect(acknowledgeNotice.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1, 2]);
    ac.abort();
  });

  it("does not flag a failure that arrives after the page was torn down", async () => {
    let fail!: (e: unknown) => void;
    const acknowledgeNotice = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([notice(1)]);
    await flush();
    ackButtons(el)[0]!.click();
    await flush();
    ac.abort();
    fail(new Error("aborted"));
    await flush();
    expect(safetyStore.getState().notices.map((n) => n.ack)).toEqual(["pending"]);
  });

  it("answers no presses once the page was torn down", async () => {
    const acknowledgeNotice = vi.fn().mockResolvedValue(undefined);
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([notice(1)]);
    await flush();
    const button = ackButtons(el)[0]!;
    const view = el.querySelector<HTMLButtonElement>(".moderation-notice-link")!;
    ac.abort();
    button.click();
    view.click();
    await flush();
    expect(acknowledgeNotice).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("stops following the store once the page was torn down", async () => {
    const { el, ac } = mount(vi.fn());
    setReadyNotices([notice(1)]);
    await flush();
    ac.abort();
    setReadyNotices([notice(1), notice(2)]);
    await flush();
    expect(ackButtons(el)).toHaveLength(1);
  });
});

async function mountThree(): Promise<Mounted> {
  const m = mount(vi.fn());
  setReadyNotices([notice(1), notice(2), notice(3)]);
  await flush();
  return m;
}

describe("focus when a notice leaves", () => {
  it("leaves focus where it was when the notice that left did not hold it", async () => {
    const { el, ac, fallback } = await mountThree();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    removeNotice(1);
    await flush();
    expect(document.activeElement).toBe(outside);
    expect(fallback).not.toHaveBeenCalled();
    expect(ackButtons(el)).toHaveLength(2);
    ac.abort();
  });

  it("moves focus to the previous notice when the last one that held it leaves", async () => {
    const { el, ac, fallback } = await mountThree();
    ackButtons(el)[2]!.focus();
    removeNotice(3);
    await flush();
    expect(document.activeElement).toBe(ackButtons(el)[1]);
    expect(fallback).not.toHaveBeenCalled();
    ac.abort();
  });

  it("moves focus to the notice that takes the place of the one that left", async () => {
    const { el, ac, fallback } = await mountThree();
    ackButtons(el)[1]!.focus();
    removeNotice(2);
    await flush();
    expect(document.activeElement).toBe(ackButtons(el)[1]);
    expect(noticeEl(el, 3).contains(document.activeElement)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    ac.abort();
  });
});
