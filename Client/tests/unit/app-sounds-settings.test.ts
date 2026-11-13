/**
 * WP M-8: the Notifications tab's "App sounds volume" slider and per-sound
 * switches. The group switches keep their pref keys (a saved setting survives);
 * the per-sound switches are new keys that default on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    notifier: {
      readsOsPermission: true,
      permissionGranted: vi.fn().mockResolvedValue(true),
      requestPermission: vi.fn(),
    },
  },
}));
vi.mock("../../src/lib/media/notificationSound", () => ({ playNotificationSound }));

import { useNotificationsTabHost } from "../helpers/notificationsTabHost";
import { setChannelMutesHost } from "../../src/lib/prefs/channelMutes";

const host = useNotificationsTabHost();
const { build } = host;

beforeEach(() => {
  localStorage.clear();
  playNotificationSound.mockClear();
  setChannelMutesHost(null);
});

function slider(tab: HTMLElement): HTMLInputElement {
  return tab.querySelector<HTMLInputElement>("[data-testid='app-sounds-volume']")!;
}

function switchFor(tab: HTMLElement, label: string): HTMLElement {
  const el = tab.querySelector<HTMLElement>(`[role='switch'][aria-label='${label}']`);
  if (el === null) throw new Error(`no switch named ${label}`);
  return el;
}

const stored = (key: string): string | null => localStorage.getItem(`owncord:settings:${key}`);

describe("App sounds volume slider", () => {
  it("is a labelled 0-100 slider that starts at 100% with a percent value text", () => {
    const s = slider(build());
    expect(s.type).toBe("range");
    expect(s.min).toBe("0");
    expect(s.max).toBe("100");
    expect(s.value).toBe("100");
    expect(s.getAttribute("aria-label")).toBe("App sounds volume");
    expect(s.getAttribute("aria-valuetext")).toBe("100%");
  });

  it("saves the percent as it moves and announces it", () => {
    const tab = build();
    const s = slider(tab);

    s.value = "35";
    s.dispatchEvent(new Event("input"));

    expect(stored("appSoundsVolume")).toBe("35");
    expect(s.getAttribute("aria-valuetext")).toBe("35%");
    expect(tab.textContent).toContain("35%");
  });

  it("shows the saved value when the tab is built again", () => {
    const first = build();
    slider(first).value = "0";
    slider(first).dispatchEvent(new Event("input"));

    const second = build();

    expect(slider(second).value).toBe("0");
    expect(slider(second).getAttribute("aria-valuetext")).toBe("0%");
  });

  it("plays one sample chime when the thumb is released, not while dragging", () => {
    const s = slider(build());
    s.dispatchEvent(new Event("input"));
    expect(playNotificationSound).not.toHaveBeenCalled();

    s.dispatchEvent(new Event("change"));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("falls back to 100% on a corrupt stored value", () => {
    localStorage.setItem("owncord:settings:appSoundsVolume", JSON.stringify("loud"));
    expect(slider(build()).value).toBe("100");
  });
});

describe("Sound style", () => {
  const choice = (tab: HTMLElement, style: string): HTMLButtonElement =>
    tab.querySelector<HTMLButtonElement>(`[data-testid='sound-style-${style}']`)!;
  const select = (tab: HTMLElement): HTMLSelectElement =>
    tab.querySelector<HTMLSelectElement>("[data-testid='sound-style-select']")!;

  it("sits right under the volume slider and starts on Modern", () => {
    const tab = build();
    const rows = [...tab.querySelectorAll<HTMLElement>(".setting-row")];
    const volume = rows.findIndex((r) => r.contains(slider(tab)));
    expect(rows[volume + 1]!.contains(choice(tab, "modern"))).toBe(true);
    expect(rows[volume + 1]!.textContent).toContain("Sound style");
    expect(rows[volume + 1]!.textContent).toContain(
      "Classic brings back the plain tones OwnCord had before.",
    );
    expect(choice(tab, "modern").getAttribute("aria-checked")).toBe("true");
    expect(choice(tab, "modern").textContent).toBe("Modern");
    expect(choice(tab, "classic").textContent).toBe("Classic");
    expect(select(tab).value).toBe("modern");
  });

  it("saves the pick and plays the message sound once in it", () => {
    const tab = build();
    playNotificationSound.mockImplementation(() => {
      // The sample plays after the save, so it sounds in the new style.
      expect(stored("soundStyle")).toBe(JSON.stringify("classic"));
    });
    choice(tab, "classic").click();
    playNotificationSound.mockImplementation(() => undefined);

    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    expect(playNotificationSound).toHaveBeenCalledWith();
    expect(choice(tab, "classic").getAttribute("aria-checked")).toBe("true");
    expect(choice(build(), "classic").getAttribute("aria-checked")).toBe("true");
  });

  it("saves from the narrow-window select as well", () => {
    const tab = build();
    select(tab).value = "classic";
    select(tab).dispatchEvent(new Event("change"));
    expect(stored("soundStyle")).toBe(JSON.stringify("classic"));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("shows Modern for a stored value it does not know", () => {
    localStorage.setItem("owncord:settings:soundStyle", JSON.stringify("retro"));
    expect(choice(build(), "modern").getAttribute("aria-checked")).toBe("true");
  });
});

describe("per-sound switches", () => {
  const SOUND_SWITCHES: ReadonlyArray<readonly [string, string]> = [
    ["Message sound", "soundMessage"],
    ["Mention sound", "soundMention"],
    ["Ring sound", "soundRing"],
    ["Ringback sound", "soundRingback"],
    ["Join and leave sounds", "soundJoinLeave"],
    ["Mute and deafen sounds", "soundMuteDeafen"],
    ["Stream sounds", "soundStream"],
    ["Connection sounds", "soundConnection"],
  ];

  it("offers one switch per sound, all on by default but push-to-talk", () => {
    const tab = build();
    for (const [label] of SOUND_SWITCHES) {
      expect(switchFor(tab, label).getAttribute("aria-checked")).toBe("true");
    }
    expect(switchFor(tab, "Push-to-talk sounds").getAttribute("aria-checked")).toBe("false");
    expect(tab.textContent).toContain("When your voice connection drops and when it is back");
    expect(tab.textContent).toContain("A quiet tick when your talk key opens and closes your mic");
    expect(tab.textContent).toContain(
      "The soft tones you hear while your call rings, and when it is not answered",
    );
  });

  it("turns the push-to-talk sound on, saving its own key", () => {
    const tab = build();
    switchFor(tab, "Push-to-talk sounds").click();
    expect(stored("soundPtt")).toBe("true");
    expect(switchFor(build(), "Push-to-talk sounds").getAttribute("aria-checked")).toBe("true");
  });

  it("turns each sound off on its own, saving only its own key", () => {
    for (const [label, key] of SOUND_SWITCHES) {
      localStorage.clear();
      const tab = build();
      switchFor(tab, label).click();
      expect(stored(key)).toBe("false");
      for (const [, other] of SOUND_SWITCHES) {
        if (other !== key) expect(stored(other)).toBeNull();
      }
      for (const group of ["notificationSounds", "callSounds", "voiceSounds"]) {
        expect(stored(group)).toBeNull();
      }
      host.container().replaceChildren();
    }
  });

  it("keeps the three group switches on their existing keys, in front of their sounds", () => {
    localStorage.setItem("owncord:settings:callSounds", "false");
    const tab = build();

    expect(switchFor(tab, "Incoming Call Sound").getAttribute("aria-checked")).toBe("false");
    switchFor(tab, "Notification Sounds").click();
    switchFor(tab, "Voice Sounds").click();
    expect(stored("notificationSounds")).toBe("false");
    expect(stored("voiceSounds")).toBe("false");

    // Each own switch sits right after its group switch, nested.
    const rows = [...tab.querySelectorAll<HTMLElement>(".setting-row")];
    const at = (label: string): number =>
      rows.findIndex((r) => r.querySelector(`[aria-label='${label}']`) !== null);
    expect(at("Message sound")).toBe(at("Notification Sounds") + 1);
    expect(at("Mention sound")).toBe(at("Notification Sounds") + 2);
    expect(at("Ring sound")).toBe(at("Incoming Call Sound") + 1);
    expect(at("Stream sounds")).toBe(at("Voice Sounds") + 3);
    expect(at("Connection sounds")).toBe(at("Voice Sounds") + 4);
    expect(at("Push-to-talk sounds")).toBe(at("Voice Sounds") + 5);
    expect(rows[at("Ring sound")]!.classList.contains("nested")).toBe(true);
  });
});

describe("Unread message badge switch", () => {
  it("is on by default and saves the pref when switched", () => {
    const tab = build();
    const sw = switchFor(tab, "Unread message badge");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(tab.textContent).toContain("Show the unread count on the taskbar or tray icon");

    sw.click();
    expect(stored("unreadBadge")).toBe("false");
    expect(sw.getAttribute("aria-checked")).toBe("false");

    sw.click();
    expect(stored("unreadBadge")).toBe("true");
  });
});
