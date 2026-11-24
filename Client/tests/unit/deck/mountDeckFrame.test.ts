import { afterEach, describe, expect, it, vi } from "vitest";
import "../../helpers/sidebarAreaMockSetup";
import { deckLog } from "../../helpers/deckLoggerSpy";
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
import { authStore } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import { createDirectButton } from "../../../src/features/direct-messages/directButton";
import { DIRECT_HEAD_CLASS } from "../../../src/features/direct-messages/dmFolder";
import { dmStore, setDmChannels } from "../../../src/stores/dm.store";
import { makeDm } from "../../helpers/dmHarness";
import { mountServerTabs } from "../../../src/features/server-rail/mountServerTabs";
import { Disposable } from "../../../src/lib/disposable";

vi.mock("../../../src/features/deck/deckStatusBar", async () => {
  const actual = await vi.importActual<typeof import("../../../src/features/deck/deckStatusBar")>(
    "../../../src/features/deck/deckStatusBar",
  );
  return { ...actual, createDeckStatusBar: vi.fn(actual.createDeckStatusBar) };
});

vi.mock("../../../src/features/direct-messages/directButton", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/features/direct-messages/directButton")
  >("../../../src/features/direct-messages/directButton");
  return { ...actual, createDirectButton: vi.fn(actual.createDirectButton) };
});

vi.mock("../../../src/features/server-rail/mountServerTabs", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/features/server-rail/mountServerTabs")
  >("../../../src/features/server-rail/mountServerTabs");
  return { ...actual, mountServerTabs: vi.fn(actual.mountServerTabs) };
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
    return { root, slots: result.frameSlots, notify: vi.fn(), onSearch: vi.fn(), ...overrides };
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
    expect(probe.observed).toEqual([root.firstElementChild, bar]);
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
    expect(root.children).toHaveLength(2);
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
  it("prepends the top bar and observes both bars", () => {
    const probe = stubObserver();
    const result = mountArea(container);
    const onSearch = vi.fn();
    const teardown = mountDeckFrame(deckInput(result, { onSearch }))!;
    const top = root.firstElementChild as HTMLElement;
    const bottom = root.lastElementChild as HTMLElement;
    expect(root.children).toHaveLength(2);
    expect(top.dataset["testid"]).toBe("deck-top-bar");
    expect(bottom.dataset["testid"]).toBe("deck-status-bar");
    expect(probe.constructed()).toBe(1);
    expect(probe.observed).toEqual([top, bottom]);

    const fire = probe.callbacks[0] as unknown as (entries: unknown[]) => void;
    fire([{ target: top, borderBoxSize: [{ blockSize: 36, inlineSize: 900 }] }]);
    expect(root.style.getPropertyValue("--deck-top-measured")).toBe("36px");
    expect(root.style.getPropertyValue("--deck-status-measured")).toBe("");

    top.querySelector<HTMLElement>("[data-testid='deck-search']")!.click();
    expect(onSearch).toHaveBeenCalledTimes(1);

    teardown();
    expect(root.style.getPropertyValue("--deck-top-measured")).toBe("");
    cleanup(result);
  });

  it("the top bar subscribes, then the status bar throws: its subscriptions are released and nothing is attached", async () => {
    const probe = stubObserver();
    const result = mountArea(container);
    await enterVoiceAndAwaitWidget();
    // Spy only after the real SidebarArea has made its own subscriptions.
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    /** A spy that calls the real method and hands back its unsubscribe wrapped in vi.fn. */
    const spyOnSubscribe = (store: { subscribeSelector: (...a: never[]) => () => void }) => {
      const real = store.subscribeSelector.bind(store);
      return vi.spyOn(store, "subscribeSelector").mockImplementation((...args) => {
        const off = vi.fn(real(...args));
        unsubscribes.push(off);
        return off;
      });
    };
    const uiSpy = spyOnSubscribe(uiStore);
    const authSpy = spyOnSubscribe(authStore);
    vi.mocked(createDeckStatusBar).mockImplementationOnce(() => {
      throw new Error("x");
    });
    const notify = vi.fn();
    try {
      expect(mountDeckFrame(deckInput(result, { notify }))).toBeNull();
      expect(uiSpy).toHaveBeenCalledTimes(1);
      expect(authSpy).toHaveBeenCalledTimes(1);
      expect(unsubscribes).toHaveLength(2);
      for (const off of unsubscribes) expect(off).toHaveBeenCalledTimes(1);
    } finally {
      uiSpy.mockRestore();
      authSpy.mockRestore();
    }
    const { userBar, voiceWidget } = result.frameSlots;
    expect(root.children).toHaveLength(0);
    expect(probe.constructed()).toBe(0);
    expect(Array.from(result.sidebarWrapper.children).slice(-2)).toEqual([voiceWidget, userBar]);
    expect(userBar.classList.contains("deck-slot")).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getMockDestroy(createVoiceWidget as MockedFn)).not.toHaveBeenCalled();
    cleanup(result);
  });

  it("appends the Direct button as the top bar's last child and marks the bar", () => {
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result))!;
    const top = root.firstElementChild as HTMLElement;
    const button = top.lastElementChild as HTMLElement;
    expect(button.dataset["testid"]).toBe("deck-direct");
    expect(top.querySelectorAll(":scope > .deck-direct")).toHaveLength(1);
    expect(top.classList.contains("has-deck-direct")).toBe(true);
    expect(createDirectButton).toHaveBeenCalledTimes(1);
    teardown();
    cleanup(result);
  });

  it("a Direct button that fails to build leaves the frame and logs one warning", () => {
    deckLog.warn.mockClear();
    deckLog.error.mockClear();
    vi.mocked(createDirectButton).mockImplementationOnce(() => {
      throw new Error("x");
    });
    const result = mountArea(container);
    const notify = vi.fn();
    const teardown = mountDeckFrame(deckInput(result, { notify }));
    expect(teardown).not.toBeNull();
    const top = root.firstElementChild as HTMLElement;
    expect(top.dataset["testid"]).toBe("deck-top-bar");
    expect(top.querySelector(".deck-direct")).toBeNull();
    expect(top.classList.contains("has-deck-direct")).toBe(false);
    expect(root.children).toHaveLength(2);
    expect(deckLog.warn).toHaveBeenCalledTimes(1);
    expect(deckLog.error).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(() => teardown!()).not.toThrow();
    cleanup(result);
  });

  it("passes revealSidebar to the Direct button, which opens the drawer for an inert header", () => {
    const result = mountArea(container);
    const sidebar = document.createElement("div");
    sidebar.setAttribute("inert", "");
    const head = document.createElement("div");
    head.className = DIRECT_HEAD_CLASS;
    head.tabIndex = -1;
    sidebar.appendChild(head);
    root.appendChild(sidebar);
    const revealSidebar = vi.fn(() => sidebar.removeAttribute("inert"));
    const teardown = mountDeckFrame(deckInput(result, { revealSidebar }))!;
    expect(vi.mocked(createDirectButton).mock.lastCall?.[0].revealSidebar).toBe(revealSidebar);
    root.querySelector<HTMLElement>("[data-testid='deck-direct']")!.click();
    expect(revealSidebar).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(head);
    teardown();
    sidebar.remove();
    cleanup(result);
  });

  it("teardown unsubscribes the Direct button", () => {
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result))!;
    const badge = root.querySelector<HTMLElement>(".deck-direct-badge")!;
    const user = { id: 7, username: "u7", avatar: "", status: "online" as const };
    setDmChannels([
      makeDm({ channelId: 7, recipient: user, participants: [user], unreadCount: 2 }),
    ]);
    dmStore.flush();
    expect(badge.textContent).toBe("2");
    teardown();
    setDmChannels([
      makeDm({ channelId: 7, recipient: user, participants: [user], unreadCount: 5 }),
    ]);
    dmStore.flush();
    expect(badge.textContent).toBe("2");
    setDmChannels([]);
    dmStore.flush();
    cleanup(result);
  });

  it("with serverTabs, calls mountServerTabs with the top bar and its owner, and the teardown removes the tabs", async () => {
    vi.mocked(mountServerTabs).mockClear();
    const result = mountArea(container);
    const serverTabs = {
      host: "h.example",
      isTornDown: () => false,
      onOpenDm: vi.fn(),
      onShowServer: vi.fn(),
      own: vi.fn(),
    };
    const teardown = mountDeckFrame(deckInput(result, { serverTabs }))!;
    const top = root.firstElementChild as HTMLElement;
    expect(mountServerTabs).toHaveBeenCalledTimes(1);
    const [deps, bar, owner] = vi.mocked(mountServerTabs).mock.calls[0]!;
    expect(deps).toBe(serverTabs);
    expect(bar).toBe(top);
    expect(owner).toBeInstanceOf(Disposable);
    expect(top.classList.contains("has-tabs-row")).toBe(true);
    await vi.dynamicImportSettled();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const nav = top.querySelector("[data-testid='server-tabs']");
    expect(nav?.nextElementSibling?.getAttribute("data-testid")).toBe("deck-direct");
    expect(top.firstElementChild?.getAttribute("data-testid")).toBe("deck-servers-btn");
    expect(top.classList.contains("has-server-tabs")).toBe(true);
    teardown();
    expect(top.querySelector("[data-testid='server-tabs']")).toBeNull();
    expect(top.querySelector("[data-testid='deck-servers-btn']")).toBeNull();
    expect(top.classList.contains("has-server-tabs")).toBe(false);
    expect(top.classList.contains("has-tabs-row")).toBe(false);
    cleanup(result);
  });

  it("without serverTabs (the web portal) mounts no tabs", () => {
    vi.mocked(mountServerTabs).mockClear();
    const result = mountArea(container);
    const teardown = mountDeckFrame(deckInput(result, { serverTabs: null }))!;
    expect(mountServerTabs).not.toHaveBeenCalled();
    expect((root.firstElementChild as HTMLElement).classList.contains("has-tabs-row")).toBe(false);
    teardown();
    cleanup(result);
  });
});
