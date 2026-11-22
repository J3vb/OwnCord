import { afterEach, describe, expect, it, vi } from "vitest";
import "../../helpers/sidebarAreaMockSetup";
import { createVoiceWidget } from "../../../src/features/voice/VoiceWidget";
import { createUserBar } from "../../../src/features/voice/UserBar";
import { leaveVoiceChannel } from "../../../src/stores/voice.store";
import {
  MockedFn,
  getMockDestroy,
  getMockMount,
  cleanup,
  enterVoiceAndAwaitWidget,
  mountArea,
  useSidebarAreaHarness,
} from "../../helpers/sidebarAreaHarness";
import { setRunningScreenLayout } from "../../../src/lib/prefs/screenLayout";
import { mountDeckFrame, type DeckFrameInput } from "../../../src/features/deck/mountDeckFrame";
import { createDeckStatusBar } from "../../../src/features/deck/deckStatusBar";
import { shellText } from "../../../src/i18n/shell";

vi.mock("../../../src/features/deck/deckStatusBar", async () => {
  const actual = await vi.importActual<typeof import("../../../src/features/deck/deckStatusBar")>(
    "../../../src/features/deck/deckStatusBar",
  );
  return { ...actual, createDeckStatusBar: vi.fn(actual.createDeckStatusBar) };
});

interface ObserverProbe {
  readonly callbacks: Array<() => void>;
  readonly observed: Element[];
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly constructed: () => number;
}

/** Records each observer's callback, every observe target and disconnect calls. */
function stubObserver(): ObserverProbe {
  const callbacks: Array<() => void> = [];
  const observed: Element[] = [];
  const disconnect = vi.fn();
  let constructed = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        constructed++;
        callbacks.push(cb);
      }
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnect();
      }
    },
  );
  return { callbacks, observed, disconnect, constructed: () => constructed };
}

describe("mountDeckFrame", () => {
  let container: HTMLDivElement;
  let root: HTMLDivElement;

  useSidebarAreaHarness((c) => {
    container = c;
    root = document.createElement("div");
    c.appendChild(root);
    setRunningScreenLayout("deck");
  });

  /** Every test builds the frame's input here, so a new field is added in one place. */
  function deckInput(
    result: ReturnType<typeof mountArea>,
    overrides: Partial<DeckFrameInput> = {},
  ): DeckFrameInput {
    return { root, slots: result.frameSlots, notify: vi.fn(), ...overrides };
  }

  afterEach(() => {
    leaveVoiceChannel();
    setRunningScreenLayout("classic");
    vi.unstubAllGlobals();
    vi.mocked(createDeckStatusBar).mockClear();
  });

  it("returns null and changes nothing in Classic", () => {
    setRunningScreenLayout("classic");
    const probe = stubObserver();
    const result = mountArea(container);
    const notify = vi.fn();
    const before = Array.from(result.sidebarWrapper.children);
    expect(mountDeckFrame(deckInput(result, { notify }))).toBeNull();
    expect(root.children).toHaveLength(0);
    expect(Array.from(result.sidebarWrapper.children)).toEqual(before);
    expect(result.frameSlots.userBar.classList.contains("deck-slot")).toBe(false);
    expect(createDeckStatusBar).not.toHaveBeenCalled();
    expect(probe.constructed()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    cleanup(result);
  });

  it("appends the status bar to root with the user bar slot then the voice slot, each with deck-slot", () => {
    const result = mountArea(container);
    const notify = vi.fn();
    const teardown = mountDeckFrame(deckInput(result, { notify }));
    expect(teardown).not.toBeNull();
    const bar = root.lastElementChild as HTMLElement;
    expect(bar.dataset["testid"]).toBe("deck-status-bar");
    expect(bar.className).toBe("deck-status-bar");
    expect(Array.from(bar.children)).toEqual([
      result.frameSlots.userBar,
      result.frameSlots.voiceWidget,
    ]);
    for (const slot of [result.frameSlots.userBar, result.frameSlots.voiceWidget]) {
      expect(slot.classList.contains("deck-slot")).toBe(true);
    }
    expect(notify).not.toHaveBeenCalled();
    teardown!();
    cleanup(result);
  });

  it("the observer writes --deck-status-measured from borderBoxSize", () => {
    const probe = stubObserver();
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result));
    const bar = root.lastElementChild!;
    expect(probe.constructed()).toBe(1);
    expect(probe.observed).toEqual([bar]);
    const fire = probe.callbacks[0] as unknown as (entries: unknown[]) => void;
    fire([{ target: bar, borderBoxSize: [{ blockSize: 52.5, inlineSize: 900 }] }]);
    expect(root.style.getPropertyValue("--deck-status-measured")).toBe("52.5px");
    // An entry for another element, or one without a box size, writes nothing.
    fire([{ target: root, borderBoxSize: [{ blockSize: 99, inlineSize: 1 }] }]);
    fire([{ target: bar, borderBoxSize: [] }]);
    expect(root.style.getPropertyValue("--deck-status-measured")).toBe("52.5px");
    teardown!();
    cleanup(result);
  });

  it("mounts without an observer where ResizeObserver does not exist", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result));
    expect(root.children).toHaveLength(1);
    expect(() => teardown!()).not.toThrow();
    cleanup(result);
  });

  it("keeps the frame and its teardown when the observer cannot start", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor() {
          throw new Error("no observer");
        }
      },
    );
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result));
    expect(teardown).not.toBeNull();
    const bar = root.lastElementChild!;
    expect(Array.from(bar.children)).toEqual([
      result.frameSlots.userBar,
      result.frameSlots.voiceWidget,
    ]);
    expect(() => teardown!()).not.toThrow();
    cleanup(result);
  });

  it("teardown clears the measured height and leaves the slots in the bar", () => {
    const probe = stubObserver();
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result))!;
    const bar = root.lastElementChild!;
    const fire = probe.callbacks[0] as unknown as (entries: unknown[]) => void;
    fire([{ target: bar, borderBoxSize: [{ blockSize: 46, inlineSize: 900 }] }]);
    teardown();
    expect(root.style.getPropertyValue("--deck-status-measured")).toBe("");
    expect(probe.disconnect).toHaveBeenCalledTimes(1);
    expect(result.frameSlots.userBar.parentElement).toBe(bar);
    cleanup(result);
  });

  it("the status bar fails to build, during a call: nothing is attached and the widget stays put", async () => {
    const probe = stubObserver();
    const result = mountArea(container);
    await enterVoiceAndAwaitWidget();
    vi.mocked(createDeckStatusBar).mockImplementationOnce(() => {
      throw new Error("x");
    });
    const notify = vi.fn();
    expect(mountDeckFrame(deckInput(result, { notify }))).toBeNull();

    const { userBar, voiceWidget } = result.frameSlots;
    expect(Array.from(result.sidebarWrapper.children).slice(-2)).toEqual([voiceWidget, userBar]);
    expect(userBar.classList.contains("deck-slot")).toBe(false);
    expect(voiceWidget.classList.contains("deck-slot")).toBe(false);
    expect(root.children).toHaveLength(0);
    expect(probe.constructed()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(shellText("deck.fallback"));
    expect(getMockDestroy(createVoiceWidget as MockedFn)).not.toHaveBeenCalled();
    const mount = getMockMount(createVoiceWidget as MockedFn);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith(voiceWidget);
    expect(voiceWidget.parentElement).toBe(result.sidebarWrapper);
    cleanup(result);
  });

  it("teardown with the slots in the status bar destroys children, then the sidebar's entries, then the frame", async () => {
    const probe = stubObserver();
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result))!;
    await enterVoiceAndAwaitWidget();
    // The widget mounted into its slot, which now sits in the bar.
    expect(getMockMount(createVoiceWidget as MockedFn)).toHaveBeenCalledWith(
      result.frameSlots.voiceWidget,
    );
    expect(result.frameSlots.voiceWidget.parentElement).toBe(root.lastElementChild);

    const log: string[] = [];
    getMockDestroy(createUserBar as MockedFn).mockImplementation(() => log.push("userBar"));
    getMockDestroy(createVoiceWidget as MockedFn).mockImplementation(() => log.push("voiceWidget"));
    probe.disconnect.mockImplementation(() => log.push("observer"));

    // What MainPage.destroy does: copy both lists once, then run its order.
    const children = [...result.children];
    const unsubscribers = [...result.unsubscribers];
    expect(() => {
      for (const child of children) child.destroy?.();
      for (const unsubscribe of unsubscribers) unsubscribe();
      teardown();
    }).not.toThrow();

    expect(log).toEqual(["userBar", "voiceWidget", "observer"]);
    expect(probe.disconnect).toHaveBeenCalledTimes(1);
  });
});
