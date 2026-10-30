import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_MUSIC_PREFS,
  MAX_SEEN_PLAYERS,
  MUSIC_PREFS_KEY,
  MUSIC_SEEN_KEY,
  isPlayerHidden,
  loadMusicPrefs,
  loadSeenPlayers,
  parseMusicPrefs,
  parseSeenPlayers,
  recordSeenPlayer,
  saveMusicPrefs,
  toMediaPrefs,
  withPlayerHidden,
} from "@lib/prefs/musicActivityPrefs";
import supportBundleSource from "../../src/lib/supportBundle.ts?raw";

describe("music activity prefs", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty", () => {
    expect(loadMusicPrefs()).toEqual(EMPTY_MUSIC_PREFS);
    expect(loadSeenPlayers()).toEqual([]);
  });

  it("round-trips the hidden players and hands them to the host", () => {
    saveMusicPrefs(withPlayerHidden(EMPTY_MUSIC_PREFS, "spotify.exe", true));
    expect(loadMusicPrefs()).toEqual({ hidden: ["spotify.exe"] });
    expect(toMediaPrefs(loadMusicPrefs())).toEqual({ hidden: ["spotify.exe"] });
  });

  it("matches ids without regard to case and hides each player once", () => {
    let prefs = withPlayerHidden(EMPTY_MUSIC_PREFS, "Spotify.exe", true);
    prefs = withPlayerHidden(prefs, "spotify.EXE", true);
    expect(prefs.hidden).toEqual(["spotify.EXE"]);
    expect(isPlayerHidden(prefs, "SPOTIFY.exe")).toBe(true);
    expect(isPlayerHidden(prefs, "vlc")).toBe(false);
    expect(withPlayerHidden(prefs, "spotify.exe", false).hidden).toEqual([]);
  });

  it("keeps what is valid in a malformed stored value, field by field, and never throws", () => {
    expect(parseMusicPrefs(null)).toEqual(EMPTY_MUSIC_PREFS);
    expect(parseMusicPrefs("x")).toEqual(EMPTY_MUSIC_PREFS);
    expect(parseMusicPrefs([])).toEqual(EMPTY_MUSIC_PREFS);
    expect(parseMusicPrefs({ hidden: "vlc" })).toEqual(EMPTY_MUSIC_PREFS);
    expect(
      parseMusicPrefs({ hidden: ["vlc", 5, "", "  ", "VLC", "x".repeat(300), " mpv "] }),
    ).toEqual({ hidden: ["vlc", "mpv"] });
  });

  it("reads a corrupt stored value as no choices", () => {
    localStorage.setItem(`owncord:settings:${MUSIC_PREFS_KEY}`, "{not json");
    expect(loadMusicPrefs()).toEqual(EMPTY_MUSIC_PREFS);
    localStorage.setItem(`owncord:settings:${MUSIC_SEEN_KEY}`, "{not json");
    expect(loadSeenPlayers()).toEqual([]);
  });

  it("parses the players seen: valid, distinct by id, capped", () => {
    expect(parseSeenPlayers("x")).toEqual([]);
    expect(
      parseSeenPlayers([
        { id: "spotify.exe", name: "Spotify" },
        { id: "SPOTIFY.exe", name: "Again" },
        { id: "", name: "No id" },
        { id: "vlc", name: "  " },
        { id: "mpv", name: "x".repeat(65) },
        { name: "No id key" },
        null,
        { id: "foobar", name: "foobar2000" },
      ]),
    ).toEqual([
      { id: "spotify.exe", name: "Spotify" },
      { id: "foobar", name: "foobar2000" },
    ]);
    const many = Array.from({ length: MAX_SEEN_PLAYERS + 20 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    expect(parseSeenPlayers(many)).toHaveLength(MAX_SEEN_PLAYERS);
  });

  it("records a player first, once, newest first, and writes only on a change", () => {
    recordSeenPlayer("spotify.exe", "Spotify");
    recordSeenPlayer("vlc", "VLC");
    recordSeenPlayer("spotify.exe", "Spotify");
    expect(loadSeenPlayers().map((p) => p.id)).toEqual(["spotify.exe", "vlc"]);

    const before = localStorage.getItem(`owncord:settings:${MUSIC_SEEN_KEY}`);
    recordSeenPlayer("SPOTIFY.exe", "Spotify");
    expect(localStorage.getItem(`owncord:settings:${MUSIC_SEEN_KEY}`)).toBe(before);

    // A renamed player updates its name.
    recordSeenPlayer("spotify.exe", "Spotify Premium");
    expect(loadSeenPlayers()[0]).toEqual({ id: "spotify.exe", name: "Spotify Premium" });
  });

  it("ignores an invalid player", () => {
    recordSeenPlayer("", "Nameless id");
    recordSeenPlayer("vlc", "   ");
    expect(loadSeenPlayers()).toEqual([]);
  });

  it("caps the history", () => {
    for (let i = 0; i < MAX_SEEN_PLAYERS + 5; i++) recordSeenPlayer(`p${i}`, `P${i}`);
    const seen = loadSeenPlayers();
    expect(seen).toHaveLength(MAX_SEEN_PLAYERS);
    expect(seen[0]?.id).toBe(`p${MAX_SEEN_PLAYERS + 4}`);
  });

  it("is device-local: none of its keys is on the support bundle's settings allowlist", () => {
    for (const key of [MUSIC_PREFS_KEY, MUSIC_SEEN_KEY, "shareMusicActivity"]) {
      expect(supportBundleSource).not.toContain(`"${key}"`);
    }
  });
});
