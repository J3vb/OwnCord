// The Command Deck top bar's ping: when it shows, what it draws, and that it
// matches the voice widget's bars. jsdom lays nothing out; the widths are
// checked in tests/e2e/deck-fold.spec.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeckPing } from "../../../src/features/deck/deckPing";
import { createSignalButton } from "../../../src/features/voice/widget/statsPane";
import { Disposable } from "../../../src/lib/disposable";
import type { ConnectionStats, QualityLevel } from "../../../src/lib/voice/connectionStats";
import { liveStatsStore, writeLiveStats } from "../../../src/lib/voice/liveStats";
import { setConnectionStatus, setSessionReplaced, uiStore } from "../../../src/stores/ui.store";
import { voiceStore, type VoiceStatus } from "../../../src/stores/voice.store";
import { statsSample } from "../../helpers/connectionStatsSample";
import { resetVoiceState } from "../../helpers/storeSeeds";

const LOUNGE = 10;
const DM_CALL = 40;

let owner: Disposable;

function setVoice(patch: Parameters<typeof voiceStore.setState>[0]): void {
  voiceStore.setState(patch);
  voiceStore.flush();
}

const status = (voiceStatus: VoiceStatus): void => setVoice((p) => ({ ...p, voiceStatus }));

function write(partial: Partial<ConnectionStats> = {}, connected = true): void {
  writeLiveStats(statsSample(partial), connected);
  liveStatsStore.flush();
}

function connection(next: "connected" | "reconnecting" | "disconnected"): void {
  setConnectionStatus(next);
  uiStore.flush();
}

function mount(): HTMLElement {
  const el = createDeckPing(owner);
  document.body.appendChild(el);
  return el;
}

const text = (el: HTMLElement): string => el.querySelector(".deck-ping-text")!.textContent ?? "";
const spoken = (el: HTMLElement): string => el.querySelector(".sr-only")!.textContent ?? "";
const fills = (svg: Element): string[] =>
  [...svg.querySelectorAll("rect")].map((r) => r.getAttribute("fill") ?? "");

beforeEach(() => {
  owner = new Disposable();
  resetVoiceState({
    currentChannelId: LOUNGE,
    voiceStatus: "connected",
    joinedAt: Date.now() - 1_000,
  });
  voiceStore.flush();
  liveStatsStore.setState(() => ({ stats: null, at: 0, connected: false }));
  liveStatsStore.flush();
  connection("connected");
});

afterEach(() => {
  owner.destroy();
  document.body.replaceChildren();
  resetVoiceState();
  voiceStore.flush();
  setSessionReplaced(false);
  connection("disconnected");
});

describe("deckPing: markup", () => {
  it("is a div.deck-ping with an aria-hidden text span and an sr-only sibling, and no tab stop", () => {
    write();
    const el = mount();
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("deck-ping");
    expect(el.dataset["testid"]).toBe("deck-ping");
    const [svg, drawnText, sr] = [...el.children];
    expect(svg!.tagName.toLowerCase()).toBe("svg");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(drawnText!.className).toBe("deck-ping-text");
    expect(drawnText!.getAttribute("aria-hidden")).toBe("true");
    expect(sr!.className).toBe("sr-only");
    expect(el.hasAttribute("aria-live")).toBe(false);
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("draws at creation, without a store change", () => {
    write({ rtt: 18.4 });
    const el = mount();
    expect(el.hidden).toBe(false);
    expect(text(el)).toBe("18 ms");
    expect(spoken(el)).toBe("Ping 18 ms. Quality: Good");
  });
});

describe("deckPing: hidden unless the call is connected and the chat is up", () => {
  const cases: Array<{ name: string; arrange: () => void }> = [
    { name: "no call", arrange: () => setVoice((p) => ({ ...p, currentChannelId: null })) },
    { name: "joining", arrange: () => status("joining") },
    { name: "securing", arrange: () => status("securing") },
    { name: "reconnecting", arrange: () => status("reconnecting") },
    { name: "available: false", arrange: () => write({ available: false }) },
    { name: "rtt 0", arrange: () => write({ rtt: 0 }) },
    {
      name: "a sample written before joinedAt",
      arrange: () => setVoice((p) => ({ ...p, joinedAt: Date.now() + 1_000 })),
    },
    { name: "a sample tagged connected: false", arrange: () => write({}, false) },
    { name: "the chat reconnecting", arrange: () => connection("reconnecting") },
    { name: "the chat disconnected", arrange: () => connection("disconnected") },
    {
      name: "signed in elsewhere",
      arrange: () => {
        setSessionReplaced(true);
        uiStore.flush();
      },
    },
  ];
  for (const c of cases) {
    it(`hidden with ${c.name}`, () => {
      write();
      const el = mount();
      expect(el.hidden).toBe(false);
      c.arrange();
      expect(el.hidden).toBe(true);
    });
  }

  it("shows in a DM call too", () => {
    setVoice((p) => ({ ...p, currentChannelId: DM_CALL }));
    write({ rtt: 31 });
    const el = mount();
    expect(el.hidden).toBe(false);
    expect(text(el)).toBe("31 ms");
  });

  it("shows again once the call is connected with a new sample", () => {
    status("reconnecting");
    const el = mount();
    expect(el.hidden).toBe(true);
    status("connected");
    write({ rtt: 22 });
    expect(el.hidden).toBe(false);
    expect(text(el)).toBe("22 ms");
  });
});

describe("deckPing: the bars", () => {
  const levels: Array<{ level: QualityLevel; lit: number; word: string }> = [
    { level: "excellent", lit: 4, word: "Good" },
    { level: "fair", lit: 3, word: "Fair" },
    { level: "poor", lit: 2, word: "Poor" },
    { level: "bad", lit: 1, word: "Bad" },
  ];
  for (const { level, lit, word } of levels) {
    it(`${level}: ${lit} bars with the widget's fills, and the word ${word}`, () => {
      const stats = statsSample({ quality: level, rtt: 41.6 });
      const widget = createSignalButton(() => {}, owner.signal);
      widget.draw(stats);
      write({ quality: level, rtt: 41.6 });
      const el = mount();
      const svg = el.querySelector("svg")!;
      expect(fills(svg)).toEqual(fills(widget.el.querySelector("svg")!));
      expect(fills(svg).filter((f) => !f.startsWith("var(--bg-active"))).toHaveLength(lit);
      expect(text(el)).toBe("42 ms");
      expect(spoken(el)).toBe(`Ping 42 ms. Quality: ${word}`);
    });
  }

  it("each redraw puts one aria-hidden SVG in place of the last", () => {
    write();
    const el = mount();
    for (const level of ["fair", "bad", "excellent"] as const) {
      write({ quality: level });
      const svgs = el.querySelectorAll("svg");
      expect(svgs).toHaveLength(1);
      expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
      expect(el.firstElementChild).toBe(svgs[0]);
    }
  });

  it("does not redraw when a sample repeats", () => {
    write({ rtt: 18 });
    const el = mount();
    const svg = el.querySelector("svg");
    const observer = new MutationObserver(() => {});
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    write({ rtt: 18.2, loss: 0.5 });
    expect(observer.takeRecords()).toEqual([]);
    expect(el.querySelector("svg")).toBe(svg);
    observer.disconnect();
  });

  it("changes nothing after owner.destroy()", () => {
    write({ rtt: 18 });
    const el = mount();
    owner.destroy();
    write({ rtt: 90, quality: "bad" });
    status("joining");
    expect(el.hidden).toBe(false);
    expect(text(el)).toBe("18 ms");
  });
});
