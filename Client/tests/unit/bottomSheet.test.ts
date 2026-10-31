import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHONE_LAYOUT_QUERY,
  closeBottomSheet,
  isPhoneLayout,
  onPhoneLayoutChange,
  openBottomSheet,
  watchNextBottomSheet,
  type BottomSheetOptions,
} from "../../src/lib/ui/bottomSheet";
import { runSessionResets } from "../../src/lib/net/sessionRegistry";

function content(): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = '<button data-testid="first">One</button><button>Two</button>';
  return box;
}

function opener(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "Open";
  document.body.appendChild(btn);
  btn.focus();
  return btn;
}

function open(extra: Partial<BottomSheetOptions> = {}): ReturnType<typeof openBottomSheet> {
  return openBottomSheet({ label: "Sheet", content: content(), ...extra });
}

const overlays = (): NodeListOf<Element> => document.querySelectorAll(".bottom-sheet-overlay");

function pointer(type: string, target: Element, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientY: y }),
  );
}

/** history.back() lands its popstate on a later task in jsdom. */
async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(async () => {
  closeBottomSheet();
  await settleHistory();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("isPhoneLayout", () => {
  it("is false where matchMedia is missing, and follows the phone query otherwise", () => {
    expect(isPhoneLayout()).toBe(false);
    const matchMedia = vi.fn((q: string) => ({ matches: q.includes("pointer: coarse") }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(isPhoneLayout()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(PHONE_LAYOUT_QUERY);
  });
});

/**
 * Evaluates the one grammar the phone query uses: comma-separated queries of
 * `and`-joined `(pointer: ...)`, `(max-width: Npx)` and `(max-height: Npx)`.
 * jsdom has no media engine, so the shape of the query is tested here.
 */
function matches(query: string, screen: { w: number; h: number; coarse: boolean }): boolean {
  return query.split(",").some((one) =>
    one.split(" and ").every((cond) => {
      const m = /^\((pointer|max-width|max-height): ?(\w+?)(px)?\)$/.exec(cond.trim());
      if (m === null) throw new Error(`unexpected condition ${cond}`);
      const value = m[2]!;
      switch (m[1]) {
        case "pointer":
          return (value === "coarse") === screen.coarse;
        case "max-width":
          return screen.w <= Number(value);
        default:
          return screen.h <= Number(value);
      }
    }),
  );
}

describe("PHONE_LAYOUT_QUERY", () => {
  const phone = (w: number, h: number, coarse = true): boolean =>
    matches(PHONE_LAYOUT_QUERY, { w, h, coarse });

  it("holds for a phone upright", () => {
    expect(phone(393, 852)).toBe(true);
    expect(phone(412, 915)).toBe(true);
  });

  it("holds for a phone on its side, which is wider than a tablet's breakpoint", () => {
    expect(phone(915, 412)).toBe(true);
    expect(phone(852, 393)).toBe(true);
  });

  it("leaves a tablet in portrait or landscape, and a desktop window, on the desktop layout", () => {
    expect(phone(1024, 1366)).toBe(false);
    expect(phone(1366, 1024)).toBe(false);
    expect(phone(900, 1200)).toBe(false);
    // A narrow or short window driven by a mouse is not a phone.
    expect(phone(393, 852, false)).toBe(false);
    expect(phone(915, 412, false)).toBe(false);
  });

  it("switches at 900 px wide and 500 px tall", () => {
    expect(phone(899, 900)).toBe(true);
    expect(phone(900, 900)).toBe(false);
    expect(phone(1200, 499)).toBe(true);
    expect(phone(1200, 500)).toBe(false);
  });
});

describe("onPhoneLayoutChange", () => {
  it("fires on a resize that crosses the phone layout, once per crossing, until aborted", () => {
    let phone = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: phone })),
    );
    const seen: boolean[] = [];
    const owner = new AbortController();
    onPhoneLayoutChange((now) => seen.push(now), owner.signal);

    window.dispatchEvent(new Event("resize"));
    expect(seen).toEqual([]);
    phone = true;
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(seen).toEqual([true]);
    phone = false;
    window.dispatchEvent(new Event("resize"));
    expect(seen).toEqual([true, false]);

    owner.abort();
    phone = true;
    window.dispatchEvent(new Event("resize"));
    expect(seen).toEqual([true, false]);
  });
});

describe("watchNextBottomSheet", () => {
  it("runs once for the next sheet to open, and not for a later one", () => {
    const fn = vi.fn();
    const owner = new AbortController();
    watchNextBottomSheet(fn, owner.signal);
    expect(fn).not.toHaveBeenCalled();
    open();
    expect(fn).toHaveBeenCalledTimes(1);
    open();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("is dropped when its signal aborts first", () => {
    const fn = vi.fn();
    const owner = new AbortController();
    watchNextBottomSheet(fn, owner.signal);
    owner.abort();
    open();
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire for an owner that was already gone (nothing opened)", () => {
    const fn = vi.fn();
    const watch = new AbortController();
    watchNextBottomSheet(fn, watch.signal);
    const gone = new AbortController();
    gone.abort();
    open({ signal: gone.signal });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("openBottomSheet", () => {
  it("mounts a labelled modal dialog on body and focuses its first control", () => {
    opener();
    const sheet = open({ testId: "s" });
    expect(sheet.panel.parentElement?.parentElement).toBe(document.body);
    expect(sheet.panel.getAttribute("role")).toBe("dialog");
    expect(sheet.panel.getAttribute("aria-modal")).toBe("true");
    expect(sheet.panel.getAttribute("aria-label")).toBe("Sheet");
    expect(sheet.panel.dataset["testid"]).toBe("s");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("first");
  });

  it("gives focus back to the opener on close, and calls onClosed once", () => {
    const btn = opener();
    const onClosed = vi.fn();
    const sheet = open({ onClosed });
    sheet.close();
    sheet.close();
    expect(overlays()).toHaveLength(0);
    expect(document.activeElement).toBe(btn);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(sheet.signal.aborted).toBe(true);
  });

  it("leaves focus alone when the action already moved it somewhere", () => {
    opener();
    const elsewhere = document.createElement("textarea");
    document.body.appendChild(elsewhere);
    const sheet = open();
    elsewhere.focus();
    sheet.close();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("uses fallbackFocus when the opener left the page", () => {
    const btn = opener();
    const fallback = document.createElement("button");
    document.body.appendChild(fallback);
    const sheet = open({ fallbackFocus: () => fallback });
    btn.remove();
    sheet.close();
    expect(document.activeElement).toBe(fallback);
  });

  it("closes on a backdrop tap but not on a tap inside", () => {
    const sheet = open();
    const overlay = overlays()[0]!;
    sheet.panel.querySelector("button")!.click();
    expect(overlays()).toHaveLength(1);
    overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlays()).toHaveLength(0);
  });

  it("closes on Escape unless the content handled it", () => {
    const sheet = open();
    const inner = sheet.panel.querySelector("button")!;
    inner.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    inner.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(overlays()).toHaveLength(1);
    inner.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(overlays()).toHaveLength(0);
  });

  it("closes when its owner's signal aborts", () => {
    const owner = new AbortController();
    const onClosed = vi.fn();
    open({ signal: owner.signal, onClosed });
    owner.abort();
    expect(overlays()).toHaveLength(0);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("opens nothing, and calls nothing back, for an owner already gone", () => {
    const owner = new AbortController();
    owner.abort();
    const onClosed = vi.fn();
    const sheet = open({ signal: owner.signal, onClosed });
    expect(overlays()).toHaveLength(0);
    expect(sheet.signal.aborted).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("closes from closeBottomSheet and from a session reset", () => {
    open();
    closeBottomSheet();
    expect(overlays()).toHaveLength(0);
    open();
    runSessionResets("server_switch");
    expect(overlays()).toHaveLength(0);
  });
});

describe("one sheet hands over to the next", () => {
  it("keeps one overlay, and the last close returns focus to the first opener", () => {
    const btn = opener();
    const firstClosed = vi.fn();
    const first = open({ onClosed: firstClosed });
    const second = open();
    expect(first.signal.aborted).toBe(true);
    expect(firstClosed).toHaveBeenCalledTimes(1);
    expect(overlays()).toHaveLength(1);
    second.close();
    expect(document.activeElement).toBe(btn);
  });

  it("pushes one history entry for the chain, and Back closes the sheet on top", async () => {
    const push = vi.spyOn(history, "pushState");
    open();
    const second = open();
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
    history.back();
    await settleHistory();
    expect(second.signal.aborted).toBe(true);
    expect(overlays()).toHaveLength(0);
  });

  it("survives a sheet opened while the previous one's back is still in flight", async () => {
    const first = open();
    first.close();
    // The first sheet's history.back() has not landed yet.
    const second = open();
    await settleHistory();
    expect(second.signal.aborted).toBe(false);
    expect(overlays()).toHaveLength(1);
    // Its own entry arrived after the back did, so Back still closes it.
    history.back();
    await settleHistory();
    expect(second.signal.aborted).toBe(true);
  });
});

describe("swipe down", () => {
  it("closes past the threshold and snaps back short of it", () => {
    const sheet = open();
    const handle = sheet.panel.querySelector(".bottom-sheet-handle")!;
    const overlay = overlays()[0]!;

    pointer("pointerdown", handle, 100);
    pointer("pointermove", overlay, 140);
    expect(sheet.panel.style.transform).toBe("translateY(40px)");
    pointer("pointerup", overlay, 140);
    expect(sheet.panel.style.transform).toBe("");
    expect(overlays()).toHaveLength(1);

    pointer("pointerdown", handle, 100);
    pointer("pointermove", overlay, 200);
    pointer("pointerup", overlay, 200);
    expect(sheet.signal.aborted).toBe(true);
  });

  it("does not drag from a control or from content not marked as a handle", () => {
    const sheet = open();
    const overlay = overlays()[0]!;
    pointer("pointerdown", sheet.panel.querySelector("button")!, 100);
    pointer("pointermove", overlay, 300);
    pointer("pointerup", overlay, 300);
    expect(sheet.signal.aborted).toBe(false);
    expect(sheet.panel.style.transform).toBe("");
  });
});
