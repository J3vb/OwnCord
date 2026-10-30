import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createUserProfilePopup } from "@components/UserProfilePopup";
import { createDmProfileSidebar } from "@components/DmProfileSidebar";
import { createDmSidebar, type DmConversation } from "@components/DmSidebar";
import { buildMusicActivityRows } from "../../src/components/settings/MusicActivityRows";
import { mountListeningCard } from "../../src/features/members/listeningCard";
import {
  listeningLine,
  rowActivity,
  type ListeningSong,
} from "../../src/features/members/listeningLine";
import { formatClock, listeningProgress } from "../../src/features/members/listeningCard";
import {
  applyGameActivityPolicy,
  applyReadyCapabilities,
  resetServerCapabilities,
  serverSupportsListeningActivity,
} from "@lib/net/serverCapabilities";
import { MUSIC_ACTIVITY_PREF_KEY, isMusicActivityShared } from "@lib/prefs/musicActivityPrefs";
import { loadPref } from "@lib/prefs/preferences";
import { loadMusicPrefs, recordSeenPlayer, saveMusicPrefs } from "@lib/prefs/musicActivityPrefs";
import { desktop } from "../../src/platform/desktop";
import { buildDmConversations } from "../../src/pages/main-page/SidebarDmHelpers";
import { dmStore } from "../../src/stores/dm.store";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const song = (overrides: Partial<ListeningSong> = {}): ListeningSong => ({
  title: "Blue in Green",
  artist: "Miles Davis",
  player: "Spotify",
  startedAt: NOW - 83_000,
  durationMs: 225_000,
  ...overrides,
});

describe("Listening lines", () => {
  it("says what the row shows", () => {
    expect(listeningLine(song())).toBe("Listening to Spotify");
  });

  it("a game beats music, music shows alone, and neither is null", () => {
    const game = { name: "VALORANT", startedAt: 1 };
    expect(rowActivity(game, song())).toEqual({ text: "Playing VALORANT", icon: "gamepad-2" });
    expect(rowActivity(null, song())).toEqual({ text: "Listening to Spotify", icon: "music" });
    expect(rowActivity(undefined, song())).toEqual({ text: "Listening to Spotify", icon: "music" });
    expect(rowActivity(game, null)).toEqual({ text: "Playing VALORANT", icon: "gamepad-2" });
    expect(rowActivity(null, null)).toBeNull();
    expect(rowActivity(undefined, undefined)).toBeNull();
  });

  it("formats a clock as m:ss, and h:mm:ss from an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
    expect(formatClock(83_000)).toBe("1:23");
    expect(formatClock(225_000)).toBe("3:45");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("elapsed is now minus the start, clamped to the length", () => {
    expect(listeningProgress(song(), NOW)).toEqual({ elapsedMs: 83_000, ratio: 83_000 / 225_000 });
    // A start in the future (a skewed clock) is not negative.
    expect(listeningProgress(song({ startedAt: NOW + 5_000 }), NOW).elapsedMs).toBe(0);
    // Past the end (the player paused or the next song is slow to appear).
    expect(listeningProgress(song({ startedAt: NOW - 999_000 }), NOW)).toEqual({
      elapsedMs: 225_000,
      ratio: 1,
    });
    // Unknown length: elapsed only, no fraction.
    expect(listeningProgress(song({ durationMs: 0 }), NOW)).toEqual({
      elapsedMs: 83_000,
      ratio: null,
    });
  });
});

describe("the song card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("draws title, artist and the progress, and ticks once a second until stopped", () => {
    const host = document.createElement("div");
    const stop = mountListeningCard(host, song(), { prefix: "upp" });
    expect(host.querySelector(".upp-listening-label")?.textContent).toBe("Listening to Spotify");
    expect(host.querySelector(".upp-listening-title")?.textContent).toBe("Blue in Green");
    expect(host.querySelector(".upp-listening-artist")?.textContent).toBe("by Miles Davis");
    expect(host.querySelector(".upp-listening-time")?.textContent).toBe("1:23 / 3:45");
    const bar = host.querySelector<HTMLElement>(".upp-listening-bar")!;
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuetext")).toBe("1:23 of 3:45");
    expect(host.querySelector<HTMLElement>(".upp-listening-fill")?.style.width).toBe("36.9%");

    vi.advanceTimersByTime(1000);
    expect(host.querySelector(".upp-listening-time")?.textContent).toBe("1:24 / 3:45");
    vi.advanceTimersByTime(4000);
    expect(host.querySelector(".upp-listening-time")?.textContent).toBe("1:28 / 3:45");

    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(host.querySelector(".upp-listening-time")?.textContent).toBe("1:28 / 3:45");
    // Stopping twice is harmless.
    expect(() => stop()).not.toThrow();
  });

  it("stops at the end of the song", () => {
    const host = document.createElement("div");
    const stop = mountListeningCard(host, song({ startedAt: NOW - 224_000 }), { prefix: "upp" });
    vi.advanceTimersByTime(5000);
    expect(host.querySelector(".upp-listening-time")?.textContent).toBe("3:45 / 3:45");
    expect(host.querySelector<HTMLElement>(".upp-listening-fill")?.style.width).toBe("100%");
    stop();
  });

  it("omits 'by' without an artist, and the bar and timer without a length", () => {
    const host = document.createElement("div");
    const stop = mountListeningCard(host, song({ artist: "", durationMs: 0 }), { prefix: "dps" });
    expect(host.querySelector(".dps-listening-artist")).toBeNull();
    expect(host.querySelector(".dps-listening-bar")).toBeNull();
    expect(host.querySelector(".dps-listening-time")).toBeNull();
    expect(host.querySelector(".dps-listening-title")?.textContent).toBe("Blue in Green");
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("keeps a long title on one line with the whole title in its tooltip", () => {
    const host = document.createElement("div");
    const long = "A very long song title ".repeat(10);
    mountListeningCard(host, song({ title: long }), { prefix: "upp" })();
    const title = host.querySelector<HTMLElement>(".upp-listening-title")!;
    expect(title.textContent).toBe(long);
    expect(title.title).toBe(long);
  });
});

describe("profile card and DM profile sidebar", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  const user = {
    id: 1,
    username: "alice",
    avatar: null,
    role: "member",
    status: "online",
  } as const;

  it("the popup shows the card under the game and ticks while it is open", () => {
    const popup = createUserProfilePopup({
      user: { ...user, activity: { name: "Factorio", startedAt: NOW - 60_000 }, listening: song() },
      anchorX: 1,
      anchorY: 1,
    });
    popup.mount(container);
    const card = container.querySelector('[data-testid="upp-listening"]')!;
    expect(card.querySelector(".upp-listening-label")?.textContent).toBe("Listening to Spotify");
    expect(card.querySelector(".upp-listening-time")?.textContent).toBe("1:23 / 3:45");
    // Under the game.
    const activity = container.querySelector('[data-testid="upp-activity"]')!;
    expect(activity.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    vi.advanceTimersByTime(3000);
    expect(card.querySelector(".upp-listening-time")?.textContent).toBe("1:26 / 3:45");
    popup.destroy?.();
  });

  it("closing the popup clears the timer", () => {
    const onClose = vi.fn();
    const popup = createUserProfilePopup({
      user: { ...user, listening: song() },
      anchorX: 1,
      anchorY: 1,
      onClose,
    });
    popup.mount(container);
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);
    const time = container.querySelector('[data-testid="upp-listening"] .upp-listening-time')!;
    popup.destroy?.();
    expect(onClose).toHaveBeenCalled();
    // Only a pending frame callback may be left; no interval keeps ticking.
    vi.advanceTimersByTime(5000);
    expect(time.textContent).toBe("1:23 / 3:45");
  });

  it("closing the popup with Escape clears the timer too", () => {
    const popup = createUserProfilePopup({
      user: { ...user, listening: song() },
      anchorX: 1,
      anchorY: 1,
    });
    popup.mount(container);
    const time = container.querySelector('[data-testid="upp-listening"] .upp-listening-time')!;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popup.isOpen()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(time.textContent).toBe("1:23 / 3:45");
  });

  it("the popup draws nothing without a song, and none for a deleted user", () => {
    const without = createUserProfilePopup({ user, anchorX: 1, anchorY: 1 });
    without.mount(container);
    expect(container.querySelector('[data-testid="upp-listening"]')?.textContent).toBe("");
    without.destroy?.();

    const deleted = createUserProfilePopup({
      user: { ...user, isDeleted: true, listening: song() },
      anchorX: 1,
      anchorY: 1,
    });
    deleted.mount(container);
    expect(container.querySelector('[data-testid="upp-listening"]')?.textContent).toBe("");
    deleted.destroy?.();
  });

  it("the DM profile sidebar shows the card, follows update() and stops its timer", () => {
    const base = { id: 1, username: "Alice", avatar: null, status: "online" as const };
    const sidebar = createDmProfileSidebar({
      user: { ...base, listening: song() },
      onClose: vi.fn(),
    });
    sidebar.mount(container);
    const card = container.querySelector('[data-testid="dps-listening"]')!;
    expect(card.querySelector(".dps-listening-title")?.textContent).toBe("Blue in Green");
    expect(card.querySelector(".dps-listening-time")?.textContent).toBe("1:23 / 3:45");
    vi.advanceTimersByTime(2000);
    expect(card.querySelector(".dps-listening-time")?.textContent).toBe("1:25 / 3:45");

    // A new song replaces the card and restarts the clock; one timer, not two.
    const timers = vi.getTimerCount();
    sidebar.update({ ...base, listening: song({ title: "So What", startedAt: Date.now() }) });
    expect(card.querySelector(".dps-listening-title")?.textContent).toBe("So What");
    expect(card.querySelector(".dps-listening-time")?.textContent).toBe("0:00 / 3:45");
    expect(vi.getTimerCount()).toBe(timers);

    sidebar.update({ ...base, listening: null });
    expect(card.textContent).toBe("");
    expect(vi.getTimerCount()).toBeLessThan(timers);

    sidebar.update({ ...base, listening: song() });
    sidebar.destroy?.();
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("DM list rows", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    dmStore.setState(() => ({ channels: [] }));
  });

  const convo = (overrides: Partial<DmConversation> = {}): DmConversation => ({
    channelId: 100,
    userId: 1,
    username: "Alice",
    avatar: null,
    status: "online",
    lastMessage: "Hello!",
    timestamp: "2025-01-01T00:00:00Z",
    unread: false,
    ...overrides,
  });

  it("draws the partner's music with the note, and changes the icon when a game takes over", () => {
    const sidebar = createDmSidebar({
      conversations: [convo({ activity: "Listening to Spotify", activityIcon: "music" })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);
    const line = () => container.querySelector('[data-testid="dm-activity-100"]');
    expect(line()?.textContent).toBe("Listening to Spotify");
    const noteIcon = line()?.querySelector("svg path")?.getAttribute("d");
    expect(noteIcon).toBe("M9 18V5l12-2v13");

    sidebar.update([convo({ activity: "Playing Factorio", activityIcon: "gamepad-2" })]);
    expect(line()?.textContent).toBe("Playing Factorio");
    expect(line()?.querySelector("svg path")?.getAttribute("d")).not.toBe(noteIcon);
    sidebar.destroy?.();
  });

  it("builds the row's line from the DM partner's copy: game, else music, 1:1 only", () => {
    const listening = { title: "T", artist: "A", player: "Spotify", startedAt: 1, durationMs: 0 };
    const partner = { id: 10, username: "bob", avatar: "", status: "online" };
    const base = {
      name: "",
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };
    const both = { ...partner, activity: { name: "Factorio", startedAt: 1 }, listening };
    const musicOnly = { ...partner, id: 11, listening };
    dmStore.setState(() => ({
      channels: [
        { ...base, channelId: 50, recipient: both, participants: [both], isGroup: false },
        { ...base, channelId: 51, recipient: musicOnly, participants: [musicOnly], isGroup: false },
        { ...base, channelId: 52, recipient: musicOnly, participants: [musicOnly], isGroup: true },
        { ...base, channelId: 53, recipient: partner, participants: [partner], isGroup: false },
      ],
    }));
    const rows = buildDmConversations(null);
    const pick = (id: number) => rows.find((r) => r.channelId === id);
    expect(pick(50)).toMatchObject({ activity: "Playing Factorio", activityIcon: "gamepad-2" });
    expect(pick(51)).toMatchObject({ activity: "Listening to Spotify", activityIcon: "music" });
    expect(pick(52)?.activity).toBeUndefined();
    expect(pick(53)?.activity).toBeUndefined();
  });
});

describe("listening_activity capability", () => {
  afterEach(() => resetServerCapabilities());

  it("is false until a ready says so, and for a server that leaves it out", () => {
    expect(serverSupportsListeningActivity()).toBe(false);
    applyReadyCapabilities({ game_activity: true });
    expect(serverSupportsListeningActivity()).toBe(false);
    applyReadyCapabilities({ listening_activity: true });
    expect(serverSupportsListeningActivity()).toBe(true);
    resetServerCapabilities();
    expect(serverSupportsListeningActivity()).toBe(false);
  });

  it("follows the one admin switch once it is stated", () => {
    applyReadyCapabilities({ game_activity: true, listening_activity: true });
    applyGameActivityPolicy(false);
    expect(serverSupportsListeningActivity()).toBe(false);
    applyGameActivityPolicy(true);
    expect(serverSupportsListeningActivity()).toBe(true);
  });

  it("a ready that advertised it off reads false, and on again after the switch", () => {
    applyReadyCapabilities({ game_activity: false, listening_activity: false });
    expect(serverSupportsListeningActivity()).toBe(false);
    applyGameActivityPolicy(true);
    expect(serverSupportsListeningActivity()).toBe(true);
  });
});

describe("Settings > Activity > music", () => {
  let signalOwner: AbortController;
  // The desktop detector loads its host call on the first read; load it now so
  // the fake-timer tests below do not wait on a module fetch.
  beforeAll(async () => {
    await import("../../src/platform/desktop/mediaRead");
  });
  const playing = {
    state: "playing",
    title: "Blue in Green",
    artist: "Miles Davis",
    player: "Spotify",
    playerId: "spotify.exe",
    positionMs: 1,
    durationMs: 2,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    localStorage.clear();
    signalOwner = new AbortController();
  });
  afterEach(() => {
    signalOwner.abort();
    resetServerCapabilities();
    vi.useRealTimers();
  });

  function mountRows(): HTMLElement {
    const host = document.createElement("div");
    for (const el of buildMusicActivityRows(signalOwner.signal)) host.appendChild(el);
    return host;
  }
  const detectedText = (host: HTMLElement): string | null | undefined =>
    host.querySelector('[data-testid="music-activity-detected"]')?.textContent;

  it("is on by default and shows what was detected", async () => {
    invoke.mockResolvedValue(playing);
    const host = mountRows();
    const toggle = host.querySelector('[data-testid="music-activity-row"] [role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(isMusicActivityShared()).toBe(true);
    await vi.waitFor(() =>
      expect(detectedText(host)).toBe("Detected now: Blue in Green on Spotify"),
    );
    expect(host.textContent).toContain("Share the music you're listening to");
  });

  it("hands the hidden players to the read", async () => {
    saveMusicPrefs({ hidden: ["vlc"] });
    invoke.mockResolvedValue({ state: "none" });
    mountRows();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("detect_media", { prefs: { hidden: ["vlc"] } }),
    );
  });

  it("says no music was detected, and treats a failing host that way", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    const host = mountRows();
    await vi.waitFor(() => expect(detectedText(host)).toBe("No music detected"));
  });

  it("keeps the line when the host answers unknown after a song", async () => {
    invoke.mockResolvedValueOnce(playing).mockResolvedValue({ state: "unknown" });
    const host = mountRows();
    await vi.waitFor(() =>
      expect(detectedText(host)).toBe("Detected now: Blue in Green on Spotify"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(detectedText(host)).toBe("Detected now: Blue in Green on Spotify");
  });

  it("says member activity is off on this server while the switch is off", async () => {
    invoke.mockResolvedValue(playing);
    applyReadyCapabilities({ game_activity: true, listening_activity: true });
    const host = mountRows();
    const note = host.querySelector<HTMLElement>('[data-testid="music-activity-server-off"]')!;
    await vi.advanceTimersByTimeAsync(0);
    expect(note.hidden).toBe(true);

    applyGameActivityPolicy(false);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Music activity is turned off on this server.");
    applyGameActivityPolicy(true);
    expect(note.hidden).toBe(true);
  });

  it("turning it off saves the pref with no toast, reads no more, and hides the line", async () => {
    invoke.mockResolvedValue(playing);
    const host = mountRows();
    await vi.advanceTimersByTimeAsync(0);
    const calls = invoke.mock.calls.length;

    (
      host.querySelector('[data-testid="music-activity-row"] [role="switch"]') as HTMLElement
    ).click();
    expect(loadPref<boolean>(MUSIC_ACTIVITY_PREF_KEY, true)).toBe(false);
    expect(document.querySelector(".toast")).toBeNull();
    const line = host.querySelector<HTMLElement>('[data-testid="music-activity-detected"]')!;
    expect(line.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke.mock.calls.length).toBe(calls);

    (
      host.querySelector('[data-testid="music-activity-row"] [role="switch"]') as HTMLElement
    ).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.length).toBe(calls + 1);
    expect(line.hidden).toBe(false);
  });

  it("stops refreshing when the pane closes", async () => {
    invoke.mockResolvedValue({ state: "none" });
    mountRows();
    await vi.advanceTimersByTimeAsync(0);
    signalOwner.abort();
    const calls = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke.mock.calls.length).toBe(calls);
  });

  describe("Your players", () => {
    const players = (host: HTMLElement) =>
      Array.from(host.querySelectorAll('[data-testid="player-row"]'));

    it("says there are none yet", () => {
      invoke.mockResolvedValue({ state: "none" });
      const host = mountRows();
      expect(host.querySelector('[data-testid="music-activity-players-empty"]')).not.toBeNull();
      expect(host.textContent).toContain("Your players");
    });

    it("lists the players seen, each with a Show to others switch that hides it", () => {
      invoke.mockResolvedValue({ state: "none" });
      recordSeenPlayer("vlc", "VLC");
      recordSeenPlayer("spotify.exe", "Spotify");
      const host = mountRows();
      const rows = players(host);
      expect(
        rows.map((r) => r.querySelector('[data-testid="player-row-name"]')?.textContent),
      ).toEqual(["Spotify", "VLC"]);
      const toggle = rows[0]!.querySelector<HTMLElement>('[role="switch"]')!;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(toggle.getAttribute("aria-label")).toBe("Show Spotify to others");
      expect(rows[0]?.textContent).toContain("Show to others");

      toggle.click();
      expect(loadMusicPrefs().hidden).toEqual(["spotify.exe"]);
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      toggle.click();
      expect(loadMusicPrefs().hidden).toEqual([]);
    });

    it("keeps a hidden player listed (off) so it can be shown again", () => {
      invoke.mockResolvedValue({ state: "none" });
      saveMusicPrefs({ hidden: ["mpv"] });
      const host = mountRows();
      const rows = players(host);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    });

    it("draws a player seen while the pane is open when the pointer comes to the list", () => {
      invoke.mockResolvedValue({ state: "none" });
      const host = mountRows();
      expect(players(host)).toHaveLength(0);
      recordSeenPlayer("spotify.exe", "Spotify");
      host
        .querySelector('[data-testid="music-activity-players"]')
        ?.dispatchEvent(new Event("pointerenter"));
      expect(players(host)).toHaveLength(1);
    });
  });

  it("draws nothing where this build cannot read the song (the web build)", () => {
    const original = desktop.mediaDetector.available;
    Object.defineProperty(desktop.mediaDetector, "available", { value: false, configurable: true });
    try {
      expect(buildMusicActivityRows(signalOwner.signal)).toEqual([]);
    } finally {
      Object.defineProperty(desktop.mediaDetector, "available", {
        value: original,
        configurable: true,
      });
    }
  });
});
