import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Disposable } from "../../../src/lib/disposable";
import { createDeckTopBar } from "../../../src/features/deck/deckTopBar";
import { shellText } from "../../../src/i18n/shell";
import { messagingText } from "../../../src/i18n/messaging";
import { authStore } from "../../../src/stores/auth.store";
import { setConnectionStatus, setSessionReplaced, uiStore } from "../../../src/stores/ui.store";
import { resetUiState } from "../../helpers/dmHarness";
import { resetAuthState } from "../../helpers/storeSeeds";

describe("createDeckTopBar", () => {
  let owner: Disposable;
  let onSearch: Mock<() => void>;

  beforeEach(() => {
    resetUiState();
    resetAuthState();
    owner = new Disposable();
    onSearch = vi.fn<() => void>();
  });

  afterEach(() => {
    owner.destroy();
    vi.restoreAllMocks();
  });

  const build = (): HTMLDivElement => createDeckTopBar({ onSearch, owner });
  const part = (bar: HTMLElement, id: string): HTMLElement =>
    bar.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
  const led = (bar: HTMLElement): HTMLElement => bar.querySelector<HTMLElement>(".deck-led")!;
  const words = (bar: HTMLElement): string => part(bar, "deck-connection").textContent ?? "";

  it("name, search and connection are in that order and drawn at build", () => {
    authStore.setState((s) => ({ ...s, serverName: "Harbour" }));
    setConnectionStatus("connected");
    const bar = build();
    expect(bar.className).toBe("deck-top-bar");
    expect(bar.dataset["testid"]).toBe("deck-top-bar");
    expect(Array.from(bar.children).map((c) => (c as HTMLElement).dataset["testid"])).toEqual([
      "deck-top-name",
      "deck-search",
      "deck-connection",
    ]);
    expect(part(bar, "deck-top-name").textContent).toBe("Harbour");
    expect(words(bar)).toBe(shellText("deck.connected"));
    const search = part(bar, "deck-search");
    expect(search.tagName).toBe("BUTTON");
    expect(search.getAttribute("type")).toBe("button");
    expect(search.getAttribute("aria-label")).toBe(messagingText("search.label"));
    expect(search.querySelector(".deck-search-text")?.textContent).toBe(
      messagingText("search.label"),
    );
    expect(search.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(search.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(led(bar).getAttribute("aria-hidden")).toBe("true");
  });

  it("the name is set as text, empty while null, and follows the store", () => {
    const bar = build();
    const name = part(bar, "deck-top-name");
    expect(name.textContent).toBe("");
    authStore.setState((s) => ({ ...s, serverName: "<img src=x onerror=1>" }));
    authStore.flush();
    expect(name.textContent).toBe("<img src=x onerror=1>");
    expect(name.children).toHaveLength(0);
    authStore.setState((s) => ({ ...s, serverName: null }));
    authStore.flush();
    expect(name.textContent).toBe("");
  });

  it("click calls onSearch once", () => {
    const bar = build();
    part(bar, "deck-search").click();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("re-renders on online/offline and on each store field (after uiStore.flush())", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const bar = build();
    expect(words(bar)).toBe(shellText("deck.unreachable"));

    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(words(bar)).toBe(shellText("banner.reconnecting"));

    setConnectionStatus("reconnecting", true);
    uiStore.flush();
    expect(words(bar)).toBe(shellText("deck.unreachable"));

    setConnectionStatus("reconnecting");
    uiStore.flush();
    onLine.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(words(bar)).toBe(shellText("deck.offline"));
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    expect(words(bar)).toBe(shellText("banner.reconnecting"));

    setSessionReplaced(true);
    uiStore.flush();
    expect(words(bar)).toBe(shellText("banner.signedInElsewhere"));
    setSessionReplaced(false);
    setConnectionStatus("connected");
    uiStore.flush();
    expect(words(bar)).toBe(shellText("deck.connected"));
  });

  it("the LED's data-state follows the label", () => {
    const bar = build();
    const seen: string[] = [];
    const step = (apply: () => void): void => {
      apply();
      uiStore.flush();
      seen.push(led(bar).dataset["state"]!);
    };
    step(() => setConnectionStatus("connected"));
    step(() => setConnectionStatus("reconnecting"));
    step(() => setConnectionStatus("disconnected"));
    step(() => {
      setConnectionStatus("reconnecting");
      setSessionReplaced(true);
    });
    expect(seen).toEqual(["connected", "reconnecting", "unreachable", "elsewhere"]);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    step(() => setSessionReplaced(false));
    expect(seen[4]).toBe("offline");
    onLine.mockRestore();
  });

  it("offline while connected keeps Connected, then reconnecting shows Offline", () => {
    setConnectionStatus("connected");
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    try {
      const bar = build();
      expect(words(bar)).toBe(shellText("deck.connected"));

      onLine.mockReturnValue(false);
      window.dispatchEvent(new Event("offline"));
      expect(words(bar)).toBe(shellText("deck.connected"));
      expect(led(bar).dataset["state"]).toBe("connected");

      setConnectionStatus("reconnecting");
      uiStore.flush();
      expect(words(bar)).toBe(shellText("deck.offline"));
      expect(led(bar).dataset["state"]).toBe("offline");
    } finally {
      onLine.mockRestore();
    }
  });

  it("owner.destroy removes every listener and subscription", () => {
    const add = vi.spyOn(window, "addEventListener");
    const subscriptions = [
      vi.spyOn(uiStore, "subscribeSelector"),
      vi.spyOn(authStore, "subscribeSelector"),
    ];
    const bar = build();
    // Two window listeners, each tied to the owner's signal, and one subscription per store.
    const windowListeners = add.mock.calls.filter(
      ([type]) => type === "online" || type === "offline",
    );
    expect(windowListeners).toHaveLength(2);
    for (const call of windowListeners) {
      expect((call[2] as AddEventListenerOptions).signal).toBe(owner.signal);
    }
    for (const spy of subscriptions) expect(spy).toHaveBeenCalledTimes(1);

    owner.destroy();
    authStore.setState((s) => ({ ...s, serverName: "After" }));
    authStore.flush();
    setConnectionStatus("connected");
    uiStore.flush();
    window.dispatchEvent(new Event("offline"));
    expect(part(bar, "deck-top-name").textContent).toBe("");
    expect(words(bar)).toBe(shellText("deck.unreachable"));
  });
});
