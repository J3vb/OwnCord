// The voice widget inside Command Deck's status bar. jsdom has no layout, so
// these pin the classes and structure deck.css hangs its rules on; the sizes
// are checked in the screen-layout e2e spec.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../../helpers/voiceSessionMock";
import * as voiceWidget from "../../helpers/voiceWidgetHarness";

vi.mock("../../../src/features/voice/livekitSession", () => voiceSession.defaults());
vi.mock("@lib/voice/connectionStats", () => voiceWidget.connectionStatsMock(true));

import { createVoiceWidget } from "../../../src/features/voice/VoiceWidget";
import { createDeckStatusBar } from "../../../src/features/deck/deckStatusBar";
import { voiceStore } from "../../../src/stores/voice.store";
import { deckRules, keywordOf, type DeckRule } from "../../helpers/deck-css";

/** Whether `rule` takes an element out of sight or out of the accessibility tree. */
function hides(rule: DeckRule): boolean {
  return rule.declarations.some(
    (d) =>
      (d.property === "display" && keywordOf(d) === "none") ||
      d.property === "visibility" ||
      d.property === "clip" ||
      d.property === "clip-path" ||
      d.property === "content-visibility",
  );
}

describe("the voice widget in the status bar", () => {
  let bar: HTMLDivElement;
  let slot: HTMLDivElement;
  let widget: ReturnType<typeof createVoiceWidget>;

  beforeEach(() => {
    voiceWidget.resetVoiceWidgetStores({ currentChannelId: 1, voiceStatus: "connected" });
    bar = createDeckStatusBar();
    slot = document.createElement("div");
    slot.classList.add("deck-slot");
    bar.appendChild(slot);
    document.body.appendChild(bar);
  });

  afterEach(() => {
    widget.destroy?.();
    bar.remove();
  });

  function mount(): void {
    widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(slot);
  }

  it("a degraded call keeps vw-secured--degraded on the chip in the bar", () => {
    voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
    mount();
    const chip = bar.querySelector<HTMLElement>("[data-testid='vw-secured']")!;
    expect(chip.classList.contains("vw-secured--degraded")).toBe(true);
    expect(chip.textContent).toBe("Unsecured");
    // The 800 px rule hides only the chip without this class, and securedBadge
    // sets display inline, which is why that rule cannot use display.
    expect(chip.style.display).toBe("inline-flex");
    expect(chip.matches(".vw-secured:not(.vw-secured--degraded)")).toBe(false);
  });

  it("a degraded call's chip matches no deck.css rule that hides it, under any media block", () => {
    voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
    mount();
    document.documentElement.classList.add("layout-deck");
    try {
      const chip = bar.querySelector<HTMLElement>("[data-testid='vw-secured']")!;
      const chain: Element[] = [];
      for (let el: Element | null = chip; el !== null; el = el.parentElement) chain.push(el);
      const hiders = deckRules().filter(hides);
      expect(hiders.length).toBeGreaterThan(0);
      const hit = hiders.flatMap((r) =>
        r.selectors
          .filter((sel) => chain.some((el) => el.matches(sel)))
          .map((sel) => `${r.media ?? "top level"}: ${sel}`),
      );
      expect(hit).toEqual([]);
    } finally {
      document.documentElement.classList.remove("layout-deck");
    }
  });

  it("a normal call's chip is the one the 800 px rule hides", () => {
    mount();
    const chip = bar.querySelector<HTMLElement>("[data-testid='vw-secured']")!;
    expect(chip.matches(".deck-status-bar .vw-secured:not(.vw-secured--degraded)")).toBe(true);
  });

  it("listen-only shows the grant button and fills the mic notice in the bar", () => {
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));
    mount();
    // The classes deck.css lifts above the call row (order: -1, full width).
    const grant = bar.querySelector<HTMLElement>(".vw-grant-mic");
    expect(grant).not.toBeNull();
    expect(grant!.style.display).toBe("block");
    expect(bar.querySelector(".vw-mic-notice")!.textContent).not.toBe("");
    expect(slot.querySelector(".voice-widget.visible")).not.toBeNull();
  });
});
