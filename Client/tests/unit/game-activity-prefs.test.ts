import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_GAME_PREFS,
  GAME_PREFS_KEY,
  GAME_SEEN_KEY,
  MAX_SEEN,
  cleanGameName,
  displayName,
  gameKey,
  isHidden,
  loadGamePrefs,
  loadSeen,
  pathKey,
  parseGamePrefs,
  parseSeen,
  recordSeen,
  saveGamePrefs,
  withHidden,
  withManual,
  withRename,
  withoutManual,
} from "@lib/prefs/gameActivityPrefs";
import { isGameActivityShared } from "@lib/presence/gameActivityBridge";
import { STORAGE_PREFIX, savePref } from "@lib/prefs/preferences";

/** Device-local game choices: valid parts are kept field by field, nothing throws. */

describe("cleanGameName", () => {
  it("trims, and accepts 1 to 128 characters", () => {
    expect(cleanGameName("  Factorio ")).toBe("Factorio");
    expect(cleanGameName("x")).toBe("x");
    expect(cleanGameName("é".repeat(128))).toBe("é".repeat(128));
    expect(cleanGameName("é".repeat(129))).toBeNull();
    expect(cleanGameName("   ")).toBeNull();
    expect(cleanGameName("")).toBeNull();
    for (const bad of [null, undefined, 5, {}, [], true]) expect(cleanGameName(bad)).toBeNull();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(cleanGameName("🎮".repeat(128))).not.toBeNull();
    expect(cleanGameName("🎮".repeat(129))).toBeNull();
  });
});

describe("parseGamePrefs", () => {
  it("reads a well-formed blob", () => {
    const parsed = parseGamePrefs({
      manual: [{ path: " C:\\Games\\a.exe ", name: " A " }],
      hidden: ["Hades"],
      renames: { Factorio: "Factory" },
    });
    expect(parsed).toEqual({
      manual: [{ path: "C:\\Games\\a.exe", name: "A" }],
      hidden: ["Hades"],
      renames: { Factorio: "Factory" },
    });
  });

  it("is empty for anything that is not an object", () => {
    for (const raw of [null, undefined, "x", 3, true, [], [{ manual: [] }]]) {
      expect(parseGamePrefs(raw)).toEqual(EMPTY_GAME_PREFS);
    }
  });

  it("drops invalid entries one by one and keeps the rest", () => {
    const parsed = parseGamePrefs({
      manual: [
        null,
        "x",
        { path: 1, name: "n" },
        { path: "", name: "n" },
        { path: "/ok", name: "" },
        { path: "/ok", name: "x".repeat(200) },
        { path: "/good", name: "Good" },
        { path: "/GOOD", name: "Duplicate by path" },
      ],
      hidden: [4, null, "", "  ", "Hades", "hades", "Elden Ring"],
      renames: { "": "x", A: "", B: 3, C: "Renamed", [" D "]: " Shown " },
    });
    expect(parsed.manual).toEqual([{ path: "/good", name: "Good" }]);
    expect(parsed.hidden).toEqual(["Hades", "Elden Ring"]);
    expect(parsed.renames).toEqual({ C: "Renamed", D: "Shown" });
  });

  it("ignores fields of the wrong shape without touching the others", () => {
    const parsed = parseGamePrefs({ manual: "nope", hidden: { a: 1 }, renames: ["x"] });
    expect(parsed).toEqual(EMPTY_GAME_PREFS);
    expect(parseGamePrefs({ manual: 5, hidden: ["A"], renames: { B: "C" } })).toEqual({
      manual: [],
      hidden: ["A"],
      renames: { B: "C" },
    });
  });

  it("ignores a field an older version wrote under another name", () => {
    expect(parseGamePrefs({ version: 1, hide: ["A"], names: { A: "B" } })).toEqual(
      EMPTY_GAME_PREFS,
    );
  });

  it("bounds what it keeps", () => {
    const manual = Array.from({ length: 150 }, (_, i) => ({ path: `/p${i}`, name: `G${i}` }));
    const hidden = Array.from({ length: 700 }, (_, i) => `H${i}`);
    const parsed = parseGamePrefs({ manual, hidden });
    expect(parsed.manual).toHaveLength(100);
    expect(parsed.hidden).toHaveLength(500);
    expect(
      parseGamePrefs({ manual: [{ path: "/" + "p".repeat(5000), name: "N" }] }).manual,
    ).toEqual([]);
  });
});

describe("parseSeen", () => {
  it("keeps valid distinct names in order, at most 50", () => {
    expect(parseSeen(["A", "a", "  ", 3, null, "B"])).toEqual(["A", "B"]);
    expect(parseSeen("A")).toEqual([]);
    expect(parseSeen(Array.from({ length: 80 }, (_, i) => `G${i}`))).toHaveLength(MAX_SEEN);
  });
});

describe("stored choices", () => {
  beforeEach(() => localStorage.clear());

  it("round-trip through localStorage", () => {
    const prefs = withHidden(withManual(EMPTY_GAME_PREFS, "/a", "A")!, "Hades", true);
    saveGamePrefs(prefs);
    expect(loadGamePrefs()).toEqual(prefs);
  });

  it("read as empty when the stored text is not JSON, or the wrong type", () => {
    localStorage.setItem(STORAGE_PREFIX + GAME_PREFS_KEY, "{broken");
    expect(loadGamePrefs()).toEqual(EMPTY_GAME_PREFS);
    localStorage.setItem(STORAGE_PREFIX + GAME_SEEN_KEY, '"text"');
    expect(loadSeen()).toEqual([]);
    savePref(GAME_PREFS_KEY, 7);
    expect(loadGamePrefs()).toEqual(EMPTY_GAME_PREFS);
    savePref(GAME_PREFS_KEY, null);
    expect(loadGamePrefs()).toEqual(EMPTY_GAME_PREFS);
  });

  it("recordSeen puts a name first once, newest first, capped at 50", () => {
    recordSeen("A");
    recordSeen("B");
    recordSeen("a");
    expect(loadSeen()).toEqual(["a", "B"]);
    for (let i = 0; i < 70; i++) recordSeen(`Game ${i}`);
    const seen = loadSeen();
    expect(seen).toHaveLength(MAX_SEEN);
    expect(seen[0]).toBe("Game 69");
    recordSeen("   ");
    expect(loadSeen()).toEqual(seen);
  });

  it("recordSeen writes nothing while the same game stays first", () => {
    recordSeen("A");
    const events: string[] = [];
    const ctl = new AbortController();
    window.addEventListener(
      "owncord:pref-change",
      (e) => events.push((e as CustomEvent<{ key: string }>).detail.key),
      { signal: ctl.signal },
    );
    recordSeen("A");
    recordSeen(" a ");
    ctl.abort();
    expect(events).toEqual([]);
  });
});

describe("changes", () => {
  it("hide and show are case-insensitive and keep one entry", () => {
    const hidden = withHidden(withHidden(EMPTY_GAME_PREFS, "Hades", true), "HADES", true);
    expect(hidden.hidden).toEqual(["HADES"]);
    expect(isHidden(hidden, "hades")).toBe(true);
    expect(isHidden(withHidden(hidden, "hades", false), "Hades")).toBe(false);
  });

  it("a rename applies by detected name; blank or the same name resets it", () => {
    const renamed = withRename(EMPTY_GAME_PREFS, "Factorio", " Factory ");
    expect(displayName(renamed, "factorio")).toBe("Factory");
    expect(displayName(renamed, "Hades")).toBe("Hades");
    expect(withRename(renamed, "Factorio", "").renames).toEqual({});
    expect(withRename(renamed, "Factorio", "Factorio").renames).toEqual({});
    expect(withRename(renamed, "Factorio", "x".repeat(200)).renames).toEqual({});
  });

  it("adding a program replaces the entry for the same path and refuses a bad name", () => {
    const one = withManual(EMPTY_GAME_PREFS, "C:\\G\\a.exe", "A")!;
    const two = withManual(one, "c:/g/A.EXE", "B")!;
    expect(two.manual).toEqual([{ path: "c:/g/A.EXE", name: "B" }]);
    expect(withManual(one, "/x", "  ")).toBeNull();
    expect(withManual(one, "  ", "N")).toBeNull();
  });

  it("removing a program also drops its rename and hide, unless the name is still in use", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "Mine")!;
    prefs = withHidden(withRename(prefs, "Mine", "Mine!"), "Mine", true);
    const removed = withoutManual(prefs, "/a", []);
    expect(removed).toEqual(EMPTY_GAME_PREFS);
    // A detected game of the same name keeps its choices.
    expect(withoutManual(prefs, "/a", ["mine"]).hidden).toEqual(["Mine"]);
    // An unknown path changes nothing.
    expect(withoutManual(prefs, "/nope", [])).toBe(prefs);
  });
});

describe("pathKey", () => {
  it("matches the scanner's normalisation: case, slashes, quotes, prefix, drive, suffix", () => {
    const same = [
      "C:\\Games\\Cool\\Cool.EXE",
      "c:/games/cool/cool.exe",
      '"C:\\Games\\Cool\\Cool.exe"',
      "\\\\?\\D:\\Games\\Cool\\Cool.exe",
      "Z:\\games\\cool\\cool.exe",
      "/games/cool/cool.exe (deleted)",
      "  /Games/Cool/cool.exe ",
    ];
    for (const raw of same) expect(pathKey(raw), raw).toBe("/games/cool/cool.exe");
    expect(pathKey("cool.exe")).toBe("cool.exe");
    expect(pathKey("/opt/a:b")).toBe("/opt/a:b");
  });
});

describe("removing an added game", () => {
  it("leaves nothing behind when the name was never a detected game", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "C:\\g\\a.exe", "Mine")!;
    prefs = withHidden(withRename(prefs, "Mine", "M"), "mine", true);
    expect(withoutManual(prefs, "c:/G/A.exe", [])).toEqual(EMPTY_GAME_PREFS);
  });
});

describe("stored under fixed keys", () => {
  beforeEach(() => localStorage.clear());

  it("keeps choices and history under their own names", () => {
    saveGamePrefs(withHidden(EMPTY_GAME_PREFS, "Hades", true));
    recordSeen("Hades");
    expect(JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}gameActivityGames`)!)).toEqual({
      manual: [],
      hidden: ["Hades"],
      renames: {},
    });
    expect(JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}gameActivitySeen`)!)).toEqual([
      "Hades",
    ]);
  });
});

describe("recordSeen history on disk", () => {
  beforeEach(() => localStorage.clear());

  const stored = (): string[] =>
    JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${GAME_SEEN_KEY}`)!) as string[];

  it("writes at most 50 names", () => {
    for (let i = 0; i < MAX_SEEN + 5; i++) recordSeen(`Game ${i}`);
    expect(stored()).toHaveLength(MAX_SEEN);
    expect(stored()[0]).toBe(`Game ${MAX_SEEN + 4}`);
  });

  it("writes a repeated name once, moved to the front", () => {
    recordSeen("A");
    recordSeen("B");
    recordSeen("C");
    recordSeen("a");
    expect(stored()).toEqual(["a", "C", "B"]);
  });
});

describe("gameKey", () => {
  it("trims and ignores case", () => {
    expect(gameKey("  Hades II ")).toBe("hades ii");
  });
});

describe("pathKey quotes", () => {
  it("trims any number of quotes from both ends only", () => {
    expect(pathKey('""/Games/A.exe""')).toBe("/games/a.exe");
    expect(pathKey('"""/Games/A.exe"')).toBe("/games/a.exe");
    expect(pathKey('"/Games/A.exe"""')).toBe("/games/a.exe");
    expect(pathKey('/Games/"A".exe')).toBe('/games/"a".exe');
  });
});

describe("parseGamePrefs limits", () => {
  it("keeps a path of exactly 4096 characters and drops one longer", () => {
    const exact = "/" + "p".repeat(4095);
    const parsed = parseGamePrefs({
      manual: [
        { path: exact, name: "Exact" },
        { path: exact + "x", name: "Long" },
      ],
    });
    expect(parsed.manual).toEqual([{ path: exact, name: "Exact" }]);
  });

  it("keeps exactly 500 renames out of more", () => {
    const renames: Record<string, string> = {};
    for (let i = 0; i < 600; i++) renames[`From ${i}`] = `To ${i}`;
    const kept = parseGamePrefs({ renames }).renames;
    expect(Object.keys(kept)).toHaveLength(500);
    expect(kept["From 499"]).toBe("To 499");
    expect(kept["From 500"]).toBeUndefined();
  });
});

describe("changes keep what they do not touch", () => {
  it("hiding a second game keeps the first hidden, and trims the stored name", () => {
    let prefs = withHidden(EMPTY_GAME_PREFS, "Hades", true);
    prefs = withHidden(prefs, "  Celeste ", true);
    expect(prefs.hidden).toEqual(["Hades", "Celeste"]);
    expect(withHidden(prefs, "hades", false).hidden).toEqual(["Celeste"]);
  });

  it("renaming one game keeps the other renames", () => {
    let prefs = withRename(EMPTY_GAME_PREFS, "Factorio", "Factory");
    prefs = withRename(prefs, "Hades", "Hades Two");
    expect(prefs.renames).toEqual({ Factorio: "Factory", Hades: "Hades Two" });
  });

  it("a name padded with spaces is stored trimmed, and is unchanged when it matches", () => {
    expect(withRename(EMPTY_GAME_PREFS, " Factorio ", "Factory").renames).toEqual({
      Factorio: "Factory",
    });
    expect(withRename(EMPTY_GAME_PREFS, " Factorio ", "Factorio").renames).toEqual({});
  });

  it("adding a program keeps the other programs and replaces only the same path", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "A")!;
    prefs = withManual(prefs, "/b", "B")!;
    prefs = withManual(prefs, "/c", "C")!;
    expect(prefs.manual.map((m) => m.name)).toEqual(["A", "B", "C"]);
    prefs = withManual(prefs, "/B", "B2")!;
    expect(prefs.manual.map((m) => m.name)).toEqual(["A", "C", "B2"]);
  });

  it("accepts a program path of 4096 characters and refuses a longer one", () => {
    expect(withManual(EMPTY_GAME_PREFS, "/" + "p".repeat(4095), "N")).not.toBeNull();
    expect(withManual(EMPTY_GAME_PREFS, "/" + "p".repeat(4096), "N")).toBeNull();
  });

  it("holds 100 programs: a new path is refused at the limit, a replacement is not", () => {
    let prefs = EMPTY_GAME_PREFS;
    for (let i = 0; i < 100; i++) prefs = withManual(prefs, `/p${i}`, `G${i}`)!;
    expect(prefs.manual).toHaveLength(100);
    expect(withManual(prefs, "/another", "Another")).toBeNull();
    const replaced = withManual(prefs, "/p5", "Renamed")!;
    expect(replaced.manual).toHaveLength(100);
    expect(replaced.manual.find((m) => m.path === "/p5")?.name).toBe("Renamed");
  });
});

describe("removing a program among others", () => {
  it("keeps the other programs", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "A")!;
    prefs = withManual(prefs, "/b", "B")!;
    expect(withoutManual(prefs, "/a", []).manual).toEqual([{ path: "/b", name: "B" }]);
  });

  it("keeps the rename and hide while another program has the same name", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "Mine")!;
    prefs = withManual(prefs, "/b", "mine")!;
    prefs = withHidden(withRename(prefs, "Mine", "Mine!"), "Mine", true);
    const next = withoutManual(prefs, "/a", []);
    expect(next.hidden).toEqual(["Mine"]);
    expect(next.renames).toEqual({ Mine: "Mine!" });
  });

  it("drops the rename and hide when the other programs have other names", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "Mine")!;
    prefs = withManual(prefs, "/b", "Another")!;
    prefs = withHidden(withRename(prefs, "Mine", "Mine!"), "Mine", true);
    const next = withoutManual(prefs, "/a", []);
    expect(next.hidden).toEqual([]);
    expect(next.renames).toEqual({});
    expect(next.manual).toEqual([{ path: "/b", name: "Another" }]);
  });

  it("drops the rename and hide when the detected history has only other names", () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "/a", "Mine")!;
    prefs = withHidden(withRename(prefs, "Mine", "Mine!"), "Mine", true);
    expect(withoutManual(prefs, "/a", ["Other game"])).toEqual(EMPTY_GAME_PREFS);
  });
});

describe("sharing switch", () => {
  beforeEach(() => localStorage.clear());

  it("is on until turned off, under its stored name", () => {
    expect(isGameActivityShared()).toBe(true);
    localStorage.setItem(`${STORAGE_PREFIX}shareGameActivity`, "false");
    expect(isGameActivityShared()).toBe(false);
  });
});
