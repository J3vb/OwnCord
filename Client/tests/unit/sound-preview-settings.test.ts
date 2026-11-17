/**
 * Settings > Notifications: the play button on each per-sound switch row, and
 * the volume and style previews sharing the one preview that runs. The
 * preview module is the real one; the player underneath is a stand-in that
 * records each spec it is asked to play and whether it was cut.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToneSpec } from "../../src/lib/media/soundTables";

const player = vi.hoisted(() => ({
  played: [] as Array<{ spec: ToneSpec; stop: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../../src/platform/desktop", async () =>
  (await import("../helpers/appSoundHost")).grantedNotifierDesktop(),
);
vi.mock("../../src/lib/media/notificationSound", () => ({
  playSpec: (spec: ToneSpec) => {
    const entry = { spec, stop: vi.fn() };
    player.played.push(entry);
    return { stop: entry.stop };
  },
}));

import { buildNotificationsTab } from "../../src/features/settings/NotificationsTab";
import { soundSpec, type AppSound } from "../../src/lib/media/soundTables";
import { setChannelMutesHost } from "../../src/lib/prefs/channelMutes";
import { PREVIEW_GAP_MS, specLengthMs } from "../../src/lib/media/soundPreview";

/** When the second sound of a preview starts, in ms. */
const secondStarts = (first: AppSound): number =>
  specLengthMs(soundSpec("modern", first)) + PREVIEW_GAP_MS;

const ALL_SOUNDS: AppSound[] = [
  "message",
  "mention",
  "ring",
  "ringback",
  "callEnded",
  "join",
  "leave",
  "moved",
  "mute",
  "unmute",
  "deafen",
  "undeafen",
  "streamStart",
  "streamEnd",
  "viewerJoin",
  "viewerLeave",
  "connectionLost",
  "pttOn",
  "pttOff",
];

/** The sound a recorded spec is, in the modern style. */
function nameOf(spec: ToneSpec): AppSound {
  const found = ALL_SOUNDS.find((s) => equal(s, spec));
  if (found === undefined) throw new Error("unknown spec");
  return found;
}
const equal = (sound: AppSound, spec: ToneSpec): boolean =>
  JSON.stringify(soundSpec("modern", sound)) === JSON.stringify(spec);
const heard = (): AppSound[] => player.played.map((p) => nameOf(p.spec));

/** Row label, button test id and the sounds it plays, in order. */
const ROWS: ReadonlyArray<readonly [string, string, AppSound[]]> = [
  ["Message sound", "message", ["message"]],
  ["Mention sound", "mention", ["mention"]],
  ["Ring sound", "ring", ["ring"]],
  ["Ringback sound", "ringback", ["ringback", "callEnded"]],
  ["Join and leave sounds", "joinLeave", ["join", "leave", "moved"]],
  ["Mute and deafen sounds", "muteDeafen", ["mute", "unmute", "deafen", "undeafen"]],
  ["Stream sounds", "stream", ["streamStart", "streamEnd", "viewerJoin", "viewerLeave"]],
  ["Connection sounds", "connection", ["connectionLost", "join"]],
  ["Push-to-talk sounds", "ptt", ["pttOn", "pttOff"]],
];

let ac: AbortController;
let tab: HTMLDivElement;

function mount(): void {
  ac = new AbortController();
  tab = buildNotificationsTab(ac.signal);
  document.body.appendChild(tab);
}

const button = (id: string): HTMLButtonElement =>
  tab.querySelector<HTMLButtonElement>(`[data-testid='sound-preview-${id}']`)!;
const icon = (id: string): string | null =>
  button(id).querySelector("svg")!.getAttribute("data-icon");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setChannelMutesHost(null);
  player.played.length = 0;
  mount();
});

afterEach(() => {
  ac.abort();
  tab.remove();
  vi.useRealTimers();
});

describe("play buttons", () => {
  it("puts a named, unpressed play button beside each per-sound switch", () => {
    for (const [label, id] of ROWS) {
      const btn = button(id);
      expect(btn.getAttribute("aria-label")).toBe(`Play ${label}`);
      expect(btn.getAttribute("type")).toBe("button");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(icon(id)).toBe("play");
      const row = btn.closest(".setting-row")!;
      expect(row.querySelector(`[role='switch'][aria-label='${label}']`)).not.toBeNull();
    }
    expect(tab.querySelectorAll(".sound-preview-btn")).toHaveLength(ROWS.length);
  });

  it.each(ROWS)("%s plays its sounds in order", (_label, id, sounds) => {
    button(id).click();
    vi.runAllTimers();
    expect(heard()).toEqual(sounds);
  });

  it("works with the row's switch off", () => {
    // The push-to-talk switch starts off.
    expect(
      tab
        .querySelector("[role='switch'][aria-label='Push-to-talk sounds']")!
        .getAttribute("aria-checked"),
    ).toBe("false");
    button("ptt").click();
    expect(heard()).toEqual(["pttOn"]);
  });

  it("shows a pressed stop button while its preview runs, then a play button again", () => {
    button("joinLeave").click();
    expect(button("joinLeave").getAttribute("aria-pressed")).toBe("true");
    expect(icon("joinLeave")).toBe("square");
    vi.runAllTimers();
    expect(button("joinLeave").getAttribute("aria-pressed")).toBe("false");
    expect(icon("joinLeave")).toBe("play");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second press stops the preview, cutting the sound in flight", () => {
    button("muteDeafen").click();
    button("muteDeafen").click();
    expect(player.played[0]!.stop).toHaveBeenCalledTimes(1);
    expect(button("muteDeafen").getAttribute("aria-pressed")).toBe("false");
    vi.runAllTimers();
    expect(heard()).toEqual(["mute"]);
  });

  it("another row's press, in the pause between sounds, supersedes the first", () => {
    button("stream").click();
    // Into the pause after the first sound.
    vi.advanceTimersByTime(secondStarts("streamStart") - 100);
    expect(heard()).toEqual(["streamStart"]);

    button("connection").click();
    expect(button("stream").getAttribute("aria-pressed")).toBe("false");
    expect(icon("stream")).toBe("play");
    expect(button("connection").getAttribute("aria-pressed")).toBe("true");
    vi.runAllTimers();
    expect(heard()).toEqual(["streamStart", "connectionLost", "join"]);
  });

  it("closing settings on the second of four sounds cuts it and leaves no timer", () => {
    button("muteDeafen").click();
    vi.advanceTimersByTime(secondStarts("mute") + 10);
    expect(heard()).toEqual(["mute", "unmute"]);

    ac.abort();
    tab.remove();

    expect(player.played[1]!.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(heard()).toEqual(["mute", "unmute"]);
  });
});

describe("volume and style previews", () => {
  const slider = (): HTMLInputElement =>
    tab.querySelector<HTMLInputElement>("[data-testid='app-sounds-volume']")!;

  it("releasing the volume slider previews the message sound and supersedes a row", () => {
    button("joinLeave").click();
    slider().dispatchEvent(new Event("change"));
    expect(player.played[0]!.stop).toHaveBeenCalledTimes(1);
    expect(button("joinLeave").getAttribute("aria-pressed")).toBe("false");
    vi.runAllTimers();
    expect(heard()).toEqual(["join", "message"]);
  });

  it("picking a style previews the message sound in it and supersedes a row", () => {
    button("ringback").click();
    tab.querySelector<HTMLButtonElement>("[data-testid='sound-style-classic']")!.click();
    expect(player.played[0]!.stop).toHaveBeenCalledTimes(1);
    expect(button("ringback").getAttribute("aria-pressed")).toBe("false");
    vi.runAllTimers();
    expect(player.played).toHaveLength(2);
    expect(player.played[1]!.spec).toEqual(soundSpec("classic", "message"));
  });

  it("a row press cuts a running slider preview", () => {
    slider().dispatchEvent(new Event("change"));
    button("ptt").click();
    expect(player.played[0]!.stop).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(heard()).toEqual(["message", "pttOn", "pttOff"]);
  });
});
