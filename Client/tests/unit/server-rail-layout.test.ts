import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOLDER_COLORS,
  RAIL_LAYOUT_KEY,
  folderOf,
  groupServers,
  groupWithNext,
  layoutHosts,
  loadLayout,
  moveItem,
  moveOutOfFolder,
  moveServer,
  parseLayout,
  reconcile,
  renameFolder,
  saveLayout,
  serverInitials,
  setFolderColor,
  shiftItem,
  toggleCollapsed,
  ungroupFolder,
  type RailLayout,
} from "@lib/prefs/serverRailLayout";

const s = (host: string) => ({ kind: "server" as const, host });
const folder = (id: string, hosts: string[], extra: { collapsed?: boolean } = {}) => ({
  kind: "folder" as const,
  id,
  name: "",
  color: FOLDER_COLORS[0] ?? "",
  collapsed: extra.collapsed ?? false,
  hosts,
});
const hostsOf = (l: RailLayout) => layoutHosts(l);

describe("reconcile", () => {
  it("drops removed hosts and appends newly saved ones at the end", () => {
    const stored: RailLayout = [s("a"), folder("f", ["b", "gone"]), s("c")];
    const out = reconcile(stored, ["a", "b", "c", "new"]);
    expect(out).toEqual([s("a"), folder("f", ["b"]), s("c"), s("new")]);
  });

  it("drops empty folders, keeps one-server folders and de-duplicates", () => {
    const stored: RailLayout = [
      folder("empty", ["x"]),
      folder("one", ["a"]),
      s("a"),
      s("b"),
      s("b"),
    ];
    const out = reconcile(stored, ["a", "b"]);
    expect(out).toEqual([folder("one", ["a"]), s("b")]);
  });

  it("builds the default layout from nothing", () => {
    expect(reconcile([], ["a", "b"])).toEqual([s("a"), s("b")]);
  });
});

describe("moveServer", () => {
  const base: RailLayout = [s("a"), s("b"), folder("f", ["c", "d"])];
  it("moves before and after a loose server", () => {
    expect(moveServer(base, "b", { type: "before", ref: s("a") })[0]).toEqual(s("b"));
    expect(hostsOf(moveServer(base, "a", { type: "after", ref: s("b") }))).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
  it("places beside a foldered server inside that folder", () => {
    const out = moveServer(base, "a", { type: "before", ref: s("d") });
    expect(out).toEqual([s("b"), folder("f", ["c", "a", "d"])]);
  });
  it("moves into a folder at the end or an index", () => {
    expect(moveServer(base, "a", { type: "into", folderId: "f" })).toEqual([
      s("b"),
      folder("f", ["c", "d", "a"]),
    ]);
    expect(moveServer(base, "a", { type: "into", folderId: "f", index: 0 })[1]).toEqual(
      folder("f", ["a", "c", "d"]),
    );
  });
  it("drops a folder its last server leaves", () => {
    const l: RailLayout = [folder("f", ["c"]), s("a")];
    expect(moveServer(l, "c", { type: "after", ref: s("a") })).toEqual([s("a"), s("c")]);
  });
  it("ignores unknown hosts, self moves and unknown targets", () => {
    expect(moveServer(base, "zzz", { type: "into", folderId: "f" })).toBe(base);
    expect(moveServer(base, "a", { type: "before", ref: s("a") })).toBe(base);
    expect(moveServer(base, "a", { type: "into", folderId: "nope" })).toBe(base);
    expect(moveServer(base, "a", { type: "after", ref: s("nope") })).toBe(base);
  });
});

describe("moveOutOfFolder", () => {
  it("puts the server right after its folder", () => {
    const l: RailLayout = [folder("f", ["a", "b"]), s("c")];
    expect(moveOutOfFolder(l, "a")).toEqual([folder("f", ["b"]), s("a"), s("c")]);
  });
  it("dissolves a folder it empties and ignores loose servers", () => {
    expect(moveOutOfFolder([folder("f", ["a"])], "a")).toEqual([s("a")]);
    const l: RailLayout = [s("a")];
    expect(moveOutOfFolder(l, "a")).toBe(l);
  });
});

describe("groupServers", () => {
  it("makes a folder of the two where the target was", () => {
    const out = groupServers([s("a"), s("b"), s("c")], "c", "a", "f1");
    expect(out).toEqual([folder("f1", ["a", "c"]), s("b")]);
  });
  it("adds to the target's folder when it already has one", () => {
    const out = groupServers([s("a"), folder("f", ["b", "c"])], "a", "b", "new");
    expect(out).toEqual([folder("f", ["b", "a", "c"])]);
  });
  it("ignores self and unknown hosts", () => {
    const l: RailLayout = [s("a"), s("b")];
    expect(groupServers(l, "a", "a", "x")).toBe(l);
    expect(groupServers(l, "a", "q", "x")).toBe(l);
  });
  it("groupWithNext needs a loose server after", () => {
    expect(groupWithNext([s("a"), s("b")], "a", "f")).toEqual([folder("f", ["b", "a"])]);
    const l: RailLayout = [s("a"), folder("f", ["b"])];
    expect(groupWithNext(l, "a", "g")).toBe(l);
    expect(groupWithNext(l, "zz", "g")).toBe(l);
  });
});

describe("folder operations", () => {
  const l: RailLayout = [s("a"), folder("f", ["b", "c"]), s("d")];
  it("renames with trim and a length cap", () => {
    expect((renameFolder(l, "f", "  Work  ")[1] as { name: string }).name).toBe("Work");
    expect((renameFolder(l, "f", "x".repeat(80))[1] as { name: string }).name).toHaveLength(32);
  });
  it("sets a palette colour only", () => {
    const pick = FOLDER_COLORS[2] ?? "";
    expect((setFolderColor(l, "f", pick)[1] as { color: string }).color).toBe(pick);
    expect(setFolderColor(l, "f", "#123456")).toBe(l);
  });
  it("toggles collapsed", () => {
    const once = toggleCollapsed(l, "f");
    expect((once[1] as { collapsed: boolean }).collapsed).toBe(true);
    expect((toggleCollapsed(once, "f")[1] as { collapsed: boolean }).collapsed).toBe(false);
  });
  it("ungroups in place", () => {
    expect(ungroupFolder(l, "f")).toEqual([s("a"), s("b"), s("c"), s("d")]);
  });
  it("moves a folder among top-level items", () => {
    expect(moveItem(l, { kind: "folder", id: "f" }, s("a"), false)).toEqual([l[1], s("a"), s("d")]);
    expect(moveItem(l, { kind: "folder", id: "f" }, s("d"), true)).toEqual([s("a"), s("d"), l[1]]);
    expect(moveItem(l, { kind: "folder", id: "f" }, { kind: "folder", id: "f" }, true)).toBe(l);
    expect(moveItem(l, { kind: "folder", id: "zz" }, s("a"), true)).toBe(l);
  });
  it("shifts items one step, within a folder for foldered servers", () => {
    expect(hostsOf(shiftItem(l, s("a"), 1))).toEqual(["b", "c", "a", "d"]);
    expect(shiftItem(l, s("a"), -1)).toBe(l);
    expect(shiftItem(l, s("b"), 1)).toEqual([s("a"), folder("f", ["c", "b"]), s("d")]);
    expect(shiftItem(l, s("b"), -1)).toBe(l);
    expect(shiftItem(l, { kind: "folder", id: "f" }, -1)[0]).toEqual(l[1]);
  });
  it("finds the folder of a host", () => {
    expect(folderOf(l, "c")?.id).toBe("f");
    expect(folderOf(l, "a")).toBeNull();
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());
  it("round-trips a layout", () => {
    const l: RailLayout = [s("a"), folder("f", ["b"], { collapsed: true })];
    saveLayout(l);
    expect(loadLayout()).toEqual(l);
  });
  it("falls back to the default on bad data", () => {
    for (const bad of ["not json", "{}", '[{"kind":"x"}]', '[{"kind":"server","host":3}]']) {
      localStorage.setItem(RAIL_LAYOUT_KEY, bad);
      expect(loadLayout()).toEqual([]);
    }
  });
  it("rejects malformed folders and repairs an unknown colour", () => {
    expect(
      parseLayout([{ kind: "folder", id: "f", name: "", color: "#fff", collapsed: 1, hosts: [] }]),
    ).toBeNull();
    expect(parseLayout([null])).toBeNull();
    const ok = parseLayout([
      { kind: "folder", id: "f", name: "n", color: "#fff", collapsed: false, hosts: ["a"] },
    ]);
    expect(ok).not.toBeNull();
    expect(ok![0]).toMatchObject({ color: FOLDER_COLORS[0] });
  });
  it("survives a throwing storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadLayout()).toEqual([]);
    expect(() => saveLayout([s("a")])).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("serverInitials", () => {
  it("uses word initials, two letters for one word, ? for empty", () => {
    expect(serverInitials("My Cool Server Here")).toBe("MCS");
    expect(serverInitials("Dragon")).toBe("DR");
    expect(serverInitials("  ")).toBe("?");
  });
});
