import { afterEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
import { guarded, pressBack } from "../helpers/backNav";

vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/logger", () => loggerMock());

import { bindSidePanel, createSidePanelGroup, type GroupedSidePanel } from "@lib/ui/sidePanel";
import { createSidePanelFrame } from "@lib/ui/sidePanelFrame";
import { createAsyncOverlayController } from "@lib/ui/asyncOverlay";
import { Disposable } from "@lib/disposable";

const owners: Disposable[] = [];
function owner(): Disposable {
  const d = new Disposable();
  owners.push(d);
  return d;
}

afterEach(() => {
  for (const d of owners.splice(0)) d.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function escapeOn(el: Element): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** A page with a header button and a mounted panel bound to it. */
function setup(): {
  root: HTMLDivElement;
  toggle: HTMLButtonElement;
  panel: HTMLDivElement;
  onClose: ReturnType<typeof vi.fn>;
  life: Disposable;
} {
  const root = document.createElement("div");
  const toggle = document.createElement("button");
  toggle.className = "pins-btn";
  toggle.setAttribute("aria-pressed", "false");
  const life = owner();
  const onClose = vi.fn(() => life.destroy());
  const frame = createSidePanelFrame({
    className: "pinned-panel",
    label: "Pins",
    title: "Pinned Messages",
    icon: "pin",
    closeLabel: "Close pins",
    testId: "pinned-panel",
    onClose,
    signal: life.signal,
  });
  frame.body.appendChild(document.createElement("button"));
  root.append(toggle, frame.root);
  document.body.appendChild(root);
  const more = document.createElement("button");
  more.className = "ch-more-btn";
  root.appendChild(more);
  bindSidePanel(
    root,
    { panel: ".pinned-panel", toggle: ".pins-btn", fallbackFocus: ".ch-more-btn" },
    onClose,
    life.signal,
  );
  return { root, toggle, panel: frame.root, onClose, life };
}

describe("createSidePanelFrame", () => {
  it("builds one header (title, subtitle, controls, Close) over a body", () => {
    const life = owner();
    const onClose = vi.fn();
    const frame = createSidePanelFrame({
      className: "media-gallery",
      label: "Channel media",
      title: "Media",
      icon: "image",
      subtitle: "in #general",
      closeLabel: "Close media",
      onClose,
      signal: life.signal,
    });
    expect(frame.root.className).toBe("side-panel media-gallery");
    expect(frame.root.getAttribute("role")).toBe("complementary");
    expect(frame.root.getAttribute("aria-label")).toBe("Channel media");
    expect(frame.title.textContent).toBe("Mediain #general");
    expect(frame.root.querySelector(".side-panel__subtitle")?.textContent).toBe("in #general");
    expect(frame.controls.parentElement?.className).toBe("side-panel__header");
    expect(frame.body.parentElement).toBe(frame.root);
    const close = frame.root.querySelector<HTMLButtonElement>(".side-panel__close")!;
    expect(close.getAttribute("aria-label")).toBe("Close media");
    close.click();
    expect(onClose).toHaveBeenCalledOnce();
    life.destroy();
    close.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("bindSidePanel", () => {
  it("presses the header button while open and releases it on close", () => {
    const { toggle, life } = setup();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    life.destroy();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("closes on Escape inside the panel or on its button, and takes the key", () => {
    const { panel, onClose } = setup();
    const e = escapeOn(panel.querySelector(".side-panel__body button")!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);

    const second = setup();
    escapeOn(second.toggle);
    expect(second.onClose).toHaveBeenCalledOnce();
  });

  it("leaves an Escape elsewhere, or one a dialog owns, alone", () => {
    const { onClose } = setup();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    expect(escapeOn(outside).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.className = "modal-overlay";
    document.body.appendChild(dialog);
    escapeOn(document.querySelector(".side-panel__body button")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the header button when it closes with focus inside", () => {
    const { panel, toggle } = setup();
    panel.querySelector<HTMLButtonElement>(".side-panel__body button")!.focus();
    escapeOn(document.activeElement!);
    expect(document.activeElement).toBe(toggle);
  });

  it("moves focus into the panel when it opens", () => {
    const { panel } = setup();
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("tabindex")).toBe("-1");
  });

  it("returns focus to the More button when a phone hides the header button", () => {
    const { toggle, life } = setup();
    toggle.style.display = "none";
    life.destroy();
    expect(document.activeElement).toBe(document.querySelector(".ch-more-btn"));
  });

  it("does not move focus when it closes with focus elsewhere", () => {
    const { life } = setup();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    life.destroy();
    expect(document.activeElement).toBe(other);
  });

  it("closes on Back on a phone", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { onClose } = setup();
    expect(guarded()).toBe(true);
    await pressBack();
    expect(onClose).toHaveBeenCalledOnce();
    expect(guarded()).toBe(false);
  });
});

function fakePanel(): GroupedSidePanel & { opened: boolean } {
  const p = {
    opened: false,
    open: vi.fn(async () => {
      p.opened = true;
    }),
    cleanup: vi.fn(() => {
      p.opened = false;
    }),
    isOpen: () => p.opened,
  };
  return p;
}

describe("createSidePanelGroup", () => {
  it("keeps one panel open: opening one closes the others", async () => {
    const pins = fakePanel();
    const media = fakePanel();
    const group = createSidePanelGroup({ pins, media });
    await group.toggle("pins");
    expect(pins.opened).toBe(true);
    await group.toggle("media");
    expect(pins.opened).toBe(false);
    expect(media.opened).toBe(true);
  });

  it("closes the open panel when its own button is pressed again", async () => {
    const pins = fakePanel();
    const group = createSidePanelGroup({ pins, media: fakePanel() });
    await group.toggle("pins");
    await group.toggle("pins");
    expect(pins.opened).toBe(false);
    expect(pins.open).toHaveBeenCalledOnce();
  });

  it("a second press on a panel still loading cancels it", async () => {
    const pins = { ...fakePanel(), isPending: vi.fn(() => true) };
    const group = createSidePanelGroup({ pins, media: fakePanel() });
    await group.toggle("pins");
    expect(pins.cleanup).toHaveBeenCalledOnce();
    expect(pins.open).not.toHaveBeenCalled();
  });

  it("open() never closes the panel it opens, and closeAll closes every one", async () => {
    const pins = fakePanel();
    const media = fakePanel();
    const group = createSidePanelGroup({ pins, media });
    await group.open("pins");
    await group.open("pins");
    expect(pins.opened).toBe(true);
    expect(pins.cleanup).not.toHaveBeenCalled();
    expect(media.cleanup).toHaveBeenCalledTimes(2);
    group.closeAll();
    expect(pins.cleanup).toHaveBeenCalledOnce();
    expect(media.cleanup).toHaveBeenCalledTimes(3);
  });

  it("a panel still loading when another opens never mounts its late answer", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let answerFirst: (v: string) => void = () => undefined;
    const build = vi.fn((data: string) => ({
      mount: (c: Element) => {
        const el = document.createElement("div");
        el.className = `panel-${data}`;
        c.appendChild(el);
      },
      destroy: vi.fn(),
    }));
    const first = createAsyncOverlayController<string>({
      getRoot: () => root,
      load: () => new Promise<string>((r) => (answerFirst = r)),
      build,
      errorLog: "x",
      errorToast: "x",
    });
    const second = createAsyncOverlayController<string>({
      getRoot: () => root,
      load: () => Promise.resolve("second"),
      build,
      errorLog: "x",
      errorToast: "x",
    });
    const group = createSidePanelGroup({
      first: { open: first.open, cleanup: first.close, isOpen: first.isOpen },
      second: { open: second.open, cleanup: second.close, isOpen: second.isOpen },
    });
    const pending = group.toggle("first");
    await group.toggle("second");
    answerFirst("first");
    await pending;
    expect(root.querySelector(".panel-first")).toBeNull();
    expect(root.querySelector(".panel-second")).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    expect(first.isOpen()).toBe(false);
    second.close();
  });
});

describe("createAsyncOverlayController isStale", () => {
  it("drops a load that lands after what it was opened for went away", async () => {
    const root = document.createElement("div");
    let stale = false;
    let answer: (v: number) => void = () => undefined;
    const build = vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() }));
    const ctrl = createAsyncOverlayController<number>({
      getRoot: () => root,
      load: () => new Promise<number>((r) => (answer = r)),
      build,
      isStale: () => stale,
      errorLog: "x",
      errorToast: "x",
    });
    const opening = ctrl.open();
    stale = true;
    answer(1);
    await opening;
    expect(build).not.toHaveBeenCalled();
    expect(ctrl.isOpen()).toBe(false);
    // The next open is not blocked by the dropped one.
    stale = false;
    const again = ctrl.open();
    answer(2);
    await again;
    expect(build).toHaveBeenCalledOnce();
    ctrl.close();
  });
});
