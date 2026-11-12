import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileAudioState } from "../../platform/contracts/mobileAudio";

const host = vi.hoisted(() => ({ setRoute: vi.fn() }));
vi.mock("../../platform/desktop", () => ({
  desktop: {
    mobileAudio: {
      watch: vi.fn(),
      setSession: vi.fn(),
      setRoute: host.setRoute,
      refresh: vi.fn(),
    },
  },
}));

import { createRouteButton, type RouteVariant } from "./routeButton";
import { mobileRouteStore } from "./mobileRoutes";
import { closeBottomSheet } from "../../lib/ui/bottomSheet";
import { resetVoiceStore, voiceStore, type VoiceState } from "../../stores/voice.store";
import { voiceText } from "../../i18n/voice";

/** Lets store notifications land; history.back() lands on a later task in jsdom. */
async function settle(turns = 5): Promise<void> {
  if (turns === 0) return;
  await new Promise((r) => setTimeout(r, 0));
  await settle(turns - 1);
}

function audio(over: Partial<MobileAudioState> = {}): MobileAudioState {
  return {
    supported: true,
    routes: [
      { kind: "speaker", name: "" },
      { kind: "earpiece", name: "" },
    ],
    active: "speaker",
    manual: null,
    interrupted: false,
    lost: 0,
    ...over,
  };
}

function report(over: Partial<MobileAudioState> = {}): void {
  mobileRouteStore.setState(() => audio(over));
}

function call(over: Partial<VoiceState> = {}): void {
  voiceStore.setState((s) => ({ ...s, currentChannelId: 7, voiceStatus: "connected", ...over }));
}

const sheet = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid='route-sheet']");
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("[data-testid='route-sheet'] [role='radio']"),
];
const row = (kind: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid='route-${kind}']`)!;
/** A key pressed where the keyboard is. */
function press(key: string): void {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

describe("route button", () => {
  let owner: AbortController;

  function mount(variant: RouteVariant = "call"): HTMLButtonElement {
    const btn = createRouteButton(variant, owner.signal);
    document.body.appendChild(btn);
    return btn;
  }

  beforeEach(() => {
    host.setRoute.mockClear();
    resetVoiceStore();
    report();
    call();
    owner = new AbortController();
  });

  afterEach(async () => {
    owner.abort();
    closeBottomSheet();
    await settle();
    document.body.replaceChildren();
  });

  it.each([
    ["call", "video-fs-btn"],
    ["dm", "dcp-btn"],
  ] as const)("takes the %s bar's button look", (variant, cls) => {
    const btn = mount(variant);
    expect(btn.className).toBe(`${cls} route-btn`);
    expect(btn.dataset.testid).toBe(`route-button-${variant}`);
    expect(btn.dataset.callControl).toBe("route");
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows in a call with more than one route", () => {
    expect(mount().hidden).toBe(false);
  });

  it.each<[string, () => void]>([
    ["the host has no route control", () => report({ supported: false })],
    ["there is one route", () => report({ routes: [{ kind: "speaker", name: "" }] })],
    ["there is no call", () => voiceStore.setState((s) => ({ ...s, currentChannelId: null }))],
    ["the call is listen-only", () => call({ listenOnly: true })],
    ["a phone call holds the call", () => call({ phoneCallHold: true })],
  ])("hides where %s, and comes back after", async (_why, apply) => {
    const btn = mount();
    apply();
    await settle();
    expect(btn.hidden).toBe(true);
    // A tap that still lands opens nothing to pick from.
    btn.click();
    expect(sheet()).toBeNull();

    report();
    call({ listenOnly: false, phoneCallHold: false });
    await settle();
    expect(btn.hidden).toBe(false);
  });

  it.each([
    ["speaker", "volume-2"],
    ["earpiece", "phone"],
    ["wired", "headphones"],
    ["bluetooth", "bluetooth"],
  ] as const)("names the %s route and draws its icon", async (kind, icon) => {
    const btn = mount();
    report({ active: kind });
    await settle();
    const label = voiceText("route.button", { route: voiceText(`route.${kind}`) });
    expect(btn.getAttribute("aria-label")).toBe(label);
    expect(btn.title).toBe(label);
    expect([...btn.querySelectorAll("svg")].map((svg) => svg.dataset.icon)).toEqual([icon]);
  });

  it("keeps its icon through a report that changes nothing it shows", async () => {
    const btn = mount();
    const icon = btn.querySelector("svg");
    report({ manual: "speaker" });
    await settle();
    expect(btn.querySelector("svg")).toBe(icon);
  });

  describe("the route sheet", () => {
    it("lists the routes as one choice, the one in use checked and focused", () => {
      const btn = mount();
      btn.click();
      const title = voiceText("route.title");
      expect(sheet()!.closest("[role='dialog']")!.getAttribute("aria-label")).toBe(title);
      const group = sheet()!.querySelector("[role='radiogroup']")!;
      expect(group.getAttribute("aria-label")).toBe(title);
      expect(rows().map((r) => [r.dataset.testid, r.getAttribute("aria-checked")])).toEqual([
        ["route-speaker", "true"],
        ["route-earpiece", "false"],
      ]);
      expect(rows().map((r) => r.textContent)).toEqual([
        voiceText("route.speaker"),
        voiceText("route.earpiece"),
      ]);
      expect(row("speaker").querySelector("[data-icon='check']")).not.toBeNull();
      expect(row("earpiece").querySelector("[data-icon='check']")).toBeNull();
      expect(sheet()!.querySelector(".route-sheet-note")!.textContent).toBe(
        voiceText("route.micNote"),
      );
      expect(document.activeElement).toBe(row("speaker"));
      expect(btn.getAttribute("aria-expanded")).toBe("true");
    });

    it("shows a Bluetooth headset by its own name, with what it is underneath", () => {
      report({
        routes: [
          { kind: "speaker", name: "" },
          { kind: "bluetooth", name: "WH-1000XM5" },
        ],
        active: "bluetooth",
      });
      mount().click();
      const named = row("bluetooth");
      expect(named.querySelector(".route-row-label")!.textContent).toBe("WH-1000XM5");
      expect(named.querySelector(".route-row-detail")!.textContent).toBe(
        voiceText("route.bluetooth"),
      );
      expect(row("speaker").querySelector(".route-row-detail")).toBeNull();
    });

    it("shows a headset without a name as what it is", () => {
      report({
        routes: [
          { kind: "speaker", name: "" },
          { kind: "bluetooth", name: "" },
        ],
      });
      mount().click();
      expect(row("bluetooth").querySelector(".route-row-label")!.textContent).toBe(
        voiceText("route.bluetooth"),
      );
      expect(row("bluetooth").querySelector(".route-row-detail")).toBeNull();
    });

    it("closes on a pick, passes it to the host and hands focus back", () => {
      const btn = mount();
      // A tap focuses the button it lands on.
      btn.focus();
      btn.click();
      row("earpiece").click();
      expect(sheet()).toBeNull();
      expect(host.setRoute.mock.calls).toEqual([["earpiece"]]);
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(btn);
    });

    it("follows the routes while it is open", async () => {
      mount().click();
      const first = row("speaker");
      report({
        routes: [
          { kind: "wired", name: "" },
          { kind: "speaker", name: "" },
          { kind: "earpiece", name: "" },
        ],
        active: "wired",
      });
      await settle();
      expect(rows().map((r) => [r.dataset.testid, r.getAttribute("aria-checked")])).toEqual([
        ["route-wired", "true"],
        ["route-speaker", "false"],
        ["route-earpiece", "false"],
      ]);
      expect(row("speaker")).not.toBe(first);

      // A row drawn after the sheet opened still picks.
      row("earpiece").click();
      expect(host.setRoute.mock.calls).toEqual([["earpiece"]]);
    });

    it("is one tab stop, and the arrow keys move through the routes without picking", () => {
      report({
        routes: [
          { kind: "speaker", name: "" },
          { kind: "earpiece", name: "" },
          { kind: "bluetooth", name: "" },
        ],
        active: "earpiece",
      });
      mount().click();
      // Tab lands on the route in use.
      expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
      expect(document.activeElement).toBe(row("earpiece"));

      press("ArrowDown");
      expect(document.activeElement).toBe(row("bluetooth"));
      expect(rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
      press("Home");
      expect(document.activeElement).toBe(row("speaker"));
      // Moving is looking: only Enter or Space picks.
      expect(host.setRoute).not.toHaveBeenCalled();
      expect(sheet()).not.toBeNull();

      press("ArrowDown");
      press("ArrowDown");
      press("Enter");
      expect(host.setRoute.mock.calls).toEqual([["bluetooth"]]);
      expect(sheet()).toBeNull();
    });

    it("keeps the keyboard on the route it was on when the routes change under it", async () => {
      mount().click();
      press("ArrowDown");
      const before = row("earpiece");
      expect(document.activeElement).toBe(before);
      // A headset is plugged in and the call moves to it: the rows are drawn again.
      report({
        routes: [
          { kind: "speaker", name: "" },
          { kind: "earpiece", name: "" },
          { kind: "wired", name: "" },
        ],
        active: "wired",
      });
      await settle();
      expect(row("earpiece")).not.toBe(before);
      expect(document.activeElement).toBe(row("earpiece"));
      // The tab stop goes with the focus, not with the route in use.
      expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
      expect(row("wired").getAttribute("aria-checked")).toBe("true");
    });

    it("moves the keyboard to the route in use when the row it was on is gone", async () => {
      report({
        routes: [
          { kind: "speaker", name: "" },
          { kind: "earpiece", name: "" },
          { kind: "bluetooth", name: "" },
        ],
        active: "bluetooth",
      });
      mount().click();
      expect(document.activeElement).toBe(row("bluetooth"));
      // The headset goes, and with it the row the keyboard was on.
      report({ active: "speaker" });
      await settle();
      expect(document.activeElement).toBe(row("speaker"));
      expect(rows().map((r) => r.tabIndex)).toEqual([0, -1]);
    });

    it("takes no focus for a redraw while the keyboard is somewhere else", async () => {
      const btn = mount();
      btn.click();
      const other = document.createElement("button");
      document.body.appendChild(other);
      other.focus();
      report({ active: "earpiece" });
      await settle();
      expect(document.activeElement).toBe(other);
      // The group still has its one tab stop, on the route in use.
      expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0]);
    });

    it("gives the group a tab stop when the route in use is not listed", () => {
      report({
        routes: [
          { kind: "earpiece", name: "" },
          { kind: "bluetooth", name: "" },
        ],
        active: "speaker",
      });
      mount().click();
      expect(rows().map((r) => r.tabIndex)).toEqual([0, -1]);
      expect(document.activeElement).toBe(row("earpiece"));
    });

    it("leaves its rows alone through a report that changes none of them", async () => {
      mount().click();
      const first = row("speaker");
      report({ manual: "speaker" });
      await settle();
      expect(row("speaker")).toBe(first);
    });

    it.each<[string, () => void]>([
      ["one route is left", () => report({ routes: [{ kind: "speaker", name: "" }] })],
      ["the call ends", () => resetVoiceStore()],
      ["a phone call holds the call", () => call({ phoneCallHold: true })],
    ])("closes when %s", async (_why, apply) => {
      const btn = mount();
      btn.click();
      expect(sheet()).not.toBeNull();
      apply();
      await settle();
      expect(sheet()).toBeNull();
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes with the button's owner", () => {
      const btn = mount();
      btn.click();
      owner.abort();
      expect(sheet()).toBeNull();
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("stops following when its owner goes", async () => {
    const btn = mount();
    owner.abort();
    report({ supported: false, active: "earpiece" });
    await settle();
    expect(btn.hidden).toBe(false);
    expect(btn.querySelector("svg")!.dataset.icon).toBe("volume-2");
    btn.click();
    expect(sheet()).toBeNull();
  });
});
