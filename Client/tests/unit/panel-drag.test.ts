import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTLE_MS,
  createPeekTarget,
  dragClock,
  dragOutcome,
  panelSwipe,
  type DragSample,
  type PeekTarget,
} from "../../src/lib/ui/panelDrag";
import { claimBack } from "../../src/lib/ui/backHistory";
import { Disposable } from "../../src/lib/disposable";
import { pressBack, settle } from "../helpers/backNav";
import { expectConsole } from "../helpers/console";
import { sendAppToBackground } from "../helpers/touch";

const samples = (...points: Array<[number, number]>): DragSample[] =>
  points.map(([dx, t]) => ({ dx, t }));

describe("dragOutcome", () => {
  it("opens at max(60 px, 40 % of the travel)", () => {
    const at = (dx: number, travel: number) =>
      dragOutcome({ dx, travel, samples: [], opening: true });
    expect(at(120, 300)).toBe("open");
    expect(at(119, 300)).toBe("close");
    expect(at(60, 100)).toBe("open");
    expect(at(59, 100)).toBe("close");
  });

  it("with no travel known the distance rule is 60 px", () => {
    expect(dragOutcome({ dx: 60, travel: 0, samples: [], opening: true })).toBe("open");
    expect(dragOutcome({ dx: 59, travel: 0, samples: [], opening: true })).toBe("close");
  });

  it("opens on a 30 px flick of 3 samples over 32 ms at about 0.9 px/ms", () => {
    const flick = samples([2, 0], [16, 16], [30, 32]);
    expect(dragOutcome({ dx: 30, travel: 300, samples: flick, opening: true })).toBe("open");
  });

  it("is no flick on 2 samples", () => {
    const two = samples([2, 0], [30, 32]);
    expect(dragOutcome({ dx: 30, travel: 300, samples: two, opening: true })).toBe("close");
  });

  it("is no flick on samples spanning under 16 ms", () => {
    const quick = samples([0, 0], [15, 7], [30, 15]);
    expect(dragOutcome({ dx: 30, travel: 300, samples: quick, opening: true })).toBe("close");
  });

  it("is no flick under 30 px", () => {
    const short = samples([1, 0], [13, 16], [25, 32]);
    expect(dragOutcome({ dx: 25, travel: 300, samples: short, opening: true })).toBe("close");
  });

  it("is no flick when slow, or when the samples are older than the last 100 ms", () => {
    const slow = samples([10, 0], [20, 40], [30, 80]);
    expect(dragOutcome({ dx: 30, travel: 300, samples: slow, opening: true })).toBe("close");
    const flick = samples([2, 0], [16, 16], [30, 32]);
    expect(dragOutcome({ dx: 30, travel: 300, samples: flick, opening: true, now: 200 })).toBe(
      "close",
    );
  });

  it("closes the same way when an open panel is dragged shut", () => {
    const flick = samples([2, 0], [16, 16], [30, 32]);
    expect(dragOutcome({ dx: 120, travel: 300, samples: [], opening: false })).toBe("close");
    expect(dragOutcome({ dx: 119, travel: 300, samples: [], opening: false })).toBe("open");
    expect(dragOutcome({ dx: 30, travel: 300, samples: flick, opening: false })).toBe("close");
  });
});

interface Panel {
  readonly el: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly target: PeekTarget;
  readonly calls: string[];
  readonly commit: ReturnType<typeof vi.fn<(open: boolean) => void>>;
}

/** A panel 300 px wide at the left edge (jsdom has no layout, so the box is stubbed). */
function panel(): Panel {
  const el = document.createElement("div");
  const backdrop = document.createElement("div");
  document.body.append(backdrop, el);
  const calls: string[] = [];
  el.getBoundingClientRect = () => {
    calls.push(`measure ${el.style.transform || "none"}`);
    return DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 600 });
  };
  const commit = vi.fn<(open: boolean) => void>();
  const target = createPeekTarget({
    surfaces: [el],
    backdrop,
    setPeek: (on) => calls.push(`peek ${on}`),
    commit,
  });
  return { el, backdrop, target, calls, commit };
}

let now = 0;
const realNow = dragClock.now;

beforeEach(() => {
  now = 1000;
  dragClock.now = () => now;
});

afterEach(async () => {
  dragClock.now = realNow;
  document.documentElement.classList.remove("reduced-motion");
  vi.useRealTimers();
  vi.restoreAllMocks();
  await settle();
  document.body.replaceChildren();
});

function noDragLeft(p: Panel): void {
  expect(p.el.style.transform).toBe("");
  expect(p.backdrop.style.opacity).toBe("");
  for (const el of [p.el, p.backdrop]) {
    expect(el.classList.contains("panel-dragging")).toBe(false);
    expect(el.classList.contains("panel-settling")).toBe(false);
  }
  expect(p.calls.at(-1)).toBe("peek false");
}

describe("panelSwipe", () => {
  it("peeks, reads the travel, then sets the closed position before the first follow", () => {
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    expect(p.calls).toEqual(["peek true", "measure none"]);
    expect(p.el.style.transform).toBe("translateX(-300px)");
    expect(p.el.classList.contains("panel-dragging")).toBe(true);
    drag.move(150);
    expect(p.el.style.transform).toBe("translateX(-150px)");
    expect(p.backdrop.style.opacity).toBe("0.5");
    drag.end(150, false);
  });

  it("a closing drag starts open and follows the other way; the right side mirrors", () => {
    const p = panel();
    const shut = panelSwipe(
      () => p.target,
      "left",
      () => false,
    );
    shut.start(-12);
    expect(p.el.style.transform).toBe("translateX(0px)");
    shut.move(-60);
    expect(p.el.style.transform).toBe("translateX(-60px)");
    shut.end(-60, false);

    const r = panel();
    r.el.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: window.innerWidth - 300, y: 0, width: 300, height: 600 });
    const open = panelSwipe(
      () => r.target,
      "right",
      () => true,
    );
    open.start(-12);
    expect(r.el.style.transform).toBe("translateX(300px)");
    open.move(-100);
    expect(r.el.style.transform).toBe("translateX(200px)");
    open.end(-100, false);
  });

  it("commits at release, settles, then leaves no inline style and destroys its Disposable", () => {
    vi.useFakeTimers();
    const destroy = vi.spyOn(Disposable.prototype, "destroy");
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(130);
    expect(drag.end(130, true)).toBe(true);
    expect(p.commit).toHaveBeenCalledWith(true);
    expect(p.el.classList.contains("panel-settling")).toBe(true);
    expect(p.el.style.transform).toBe("translateX(0px)");
    expect(p.calls).not.toContain("peek false");
    vi.advanceTimersByTime(SETTLE_MS);
    noDragLeft(p);
    expect(destroy).toHaveBeenCalled();
  });

  it("a short slow drag snaps back", () => {
    vi.useFakeTimers();
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(100);
    drag.end(100, true);
    expect(p.commit).toHaveBeenCalledWith(false);
    expect(p.el.style.transform).toBe("translateX(-300px)");
    vi.advanceTimersByTime(SETTLE_MS);
    noDragLeft(p);
  });

  it("a timed flick opens", () => {
    vi.useFakeTimers();
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    for (const dx of [12, 26, 40]) {
      drag.move(dx);
      now += 16;
    }
    now -= 16;
    drag.end(40, true);
    expect(p.commit).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(SETTLE_MS);
  });

  it("a second drag drops the first, whose handle then does nothing", () => {
    const a = panel();
    const b = panel();
    const first = panelSwipe(
      () => a.target,
      "left",
      () => true,
    );
    const second = panelSwipe(
      () => b.target,
      "left",
      () => true,
    );
    first.start(12);
    second.start(12);
    noDragLeft(a);
    first.move(200);
    expect(a.el.style.transform).toBe("");
    expect(first.end(200, true)).toBe(true);
    expect(a.commit).not.toHaveBeenCalled();
    expect(b.el.style.transform).toBe("translateX(-300px)");
    second.end(12, false);
  });

  it("a cancelled handle ignores move and end, and the lift opens nothing", () => {
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(100);
    sendAppToBackground();
    noDragLeft(p);
    drag.move(250);
    expect(p.el.style.transform).toBe("");
    expect(drag.end(250, true)).toBe(true);
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("a turn that stays on the phone layout is not a cancel: the drag keeps its travel", () => {
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    vi.stubGlobal("innerWidth", window.innerWidth + 200);
    window.dispatchEvent(new Event("resize"));
    vi.unstubAllGlobals();
    drag.move(100);
    expect(p.el.style.transform).toBe("translateX(-200px)");
    drag.end(100, false);
    noDragLeft(p);
  });

  it("an interrupted swipe cancels: nothing commits and nothing is left", () => {
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(250);
    expect(drag.end(250, false)).toBe(true);
    expect(p.commit).not.toHaveBeenCalled();
    noDragLeft(p);
  });

  it("a thrown move drops the drag", () => {
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    dragClock.now = () => {
      throw new Error("clock gone");
    };
    drag.move(200);
    expectConsole("warn", "panel drag failed to follow");
    noDragLeft(p);
    expect(drag.end(200, true)).toBe(true);
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("no target, or reduced motion, is no drag: end leaves the release to the caller", () => {
    const none = panelSwipe(
      () => null,
      "left",
      () => true,
    );
    none.start(12);
    expect(none.end(100, true)).toBe(false);
    document.documentElement.classList.add("reduced-motion");
    const p = panel();
    const getTarget = vi.fn(() => p.target);
    const drag = panelSwipe(getTarget, "left", () => true);
    drag.start(12);
    drag.move(100);
    expect(getTarget).not.toHaveBeenCalled();
    expect(p.calls).toEqual([]);
    expect(drag.end(100, true)).toBe(false);
  });

  it("a Back while the finger is down cancels the drag, and Back does its own job", async () => {
    const onBack = vi.fn();
    const owner = new AbortController();
    claimBack(onBack, owner.signal);
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(200);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    noDragLeft(p);
    expect(drag.end(200, true)).toBe(true);
    expect(p.commit).not.toHaveBeenCalled();
    owner.abort();
  });

  it("after the lift a Back no longer touches the drag", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = panel();
    const drag = panelSwipe(
      () => p.target,
      "left",
      () => true,
    );
    drag.start(12);
    drag.move(200);
    drag.end(200, true);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(p.el.classList.contains("panel-settling")).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    noDragLeft(p);
  });
});
