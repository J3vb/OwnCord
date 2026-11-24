/**
 * The server tabs' menu items: the shared builders with an axis and without
 * Expand/Collapse, plus Move to start and one Move to {folder} row per folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRailController,
  type RailController,
} from "../../../src/features/server-rail/railController";
import { folderMenu, serverMenu } from "../../../src/features/server-rail/serverRailMenus";
import {
  folderItems,
  folderName,
  serverItems,
  type TabMenuContext,
} from "../../../src/features/server-rail/serverTabMenus";
import { serverRailText } from "../../../src/i18n/serverRail";
import { RAIL_LAYOUT_KEY, type FolderItem } from "@lib/prefs/serverRailLayout";
import type { ServerProfile } from "@lib/presence/profiles";
import type { ContextMenuItem } from "@lib/ui/contextMenu";

function profile(name: string, host: string): ServerProfile {
  return {
    id: host,
    name,
    host,
    username: "u",
    autoConnect: false,
    rememberPassword: false,
    color: "#5865f2",
    lastConnected: null,
  };
}

const PROFILES = [
  profile("Alpha", "a.example"),
  profile("Beta", "b.example"),
  profile("Gamma", "c.example"),
  profile("Delta", "d.example"),
];

const work: FolderItem = {
  kind: "folder",
  id: "f1",
  name: "Work",
  color: "#3ba55d",
  collapsed: false,
  hosts: ["c.example"],
};
const unnamed: FolderItem = { ...work, id: "f2", name: "", hosts: ["d.example"] };

let ctl: RailController;
let ctx: TabMenuContext;

const stored = (): unknown => JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "null");
/** The stored top-level order: a host, or a folder's id. */
const order = (): string[] =>
  (stored() as Array<{ host?: string; id?: string }>).map((i) => i.host ?? i.id ?? "");
const byId = (items: readonly ContextMenuItem[], id: string): ContextMenuItem => {
  const found = items.find((i) => i.testId === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
};
const click = (item: ContextMenuItem): void => item.onClick(new MouseEvent("click"));

async function mount(layout: unknown): Promise<void> {
  localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(layout));
  ctl = createRailController({
    currentHost: "a.example",
    loadServers: () => Promise.resolve(PROFILES),
    switchServer: vi.fn(),
    addServer: vi.fn(),
    joinInvite: () => false,
    newFolderId: () => "fid",
  });
  ctl.start(() => {});
  for (let i = 0; i < 3; i++) await Promise.resolve();
  ctx = { ctl, open: vi.fn(), activate: vi.fn() };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  ctl.destroy();
});

describe("serverTabMenus", () => {
  it("axis x gives Move left and Move right with their icons and test ids, for a server and for a folder", async () => {
    await mount([
      { kind: "server", host: "a.example" },
      work,
      { kind: "server", host: "b.example" },
    ]);
    for (const items of [serverItems("b.example", "row", ctx), folderItems(work, "row", ctx)]) {
      const left = byId(items, "rail-move-left");
      const right = byId(items, "rail-move-right");
      expect([left.label, left.icon]).toEqual([serverRailText("moveLeft"), "arrow-left"]);
      expect([right.label, right.icon]).toEqual([serverRailText("moveRight"), "arrow-right"]);
      expect(items.some((i) => i.testId === "rail-move-up")).toBe(false);
    }
    click(byId(folderItems(work, "row", ctx), "rail-move-left"));
    expect(order()).toEqual(["f1", "a.example", "b.example", "d.example"]);
  });

  it("axis y keeps Move up and Move down", async () => {
    await mount([work, { kind: "server", host: "a.example" }]);
    const member = serverItems("c.example", "member", ctx);
    expect(member.map((i) => i.testId)).toEqual([
      "rail-move-up",
      "rail-move-down",
      "rail-remove-from-folder",
    ]);
    const inServers = serverItems("a.example", "servers", ctx);
    expect(byId(inServers, "rail-move-up").label).toBe(serverRailText("moveUp"));
    const folder = folderItems(work, "servers", ctx).map((i) => i.label);
    expect(folder).toContain(serverRailText("moveUp"));
    expect(folder).not.toContain(serverRailText("moveLeft"));
  });

  it("collapsible false drops Expand and Collapse", async () => {
    await mount([work, { ...unnamed, collapsed: true }]);
    for (const folder of [work, { ...unnamed, collapsed: true }]) {
      const labels = folderItems(folder, "row", ctx).map((i) => i.label);
      expect(labels).not.toContain(serverRailText("expand"));
      expect(labels).not.toContain(serverRailText("collapse"));
      expect(labels[0]).toBe(serverRailText("renameFolder"));
    }
  });

  it("Move to start moves the item first, reading the layout at click time", async () => {
    await mount([
      { kind: "server", host: "a.example" },
      { kind: "server", host: "b.example" },
      work,
      { kind: "server", host: "d.example" },
    ]);
    const start = byId(serverItems("d.example", "more", ctx), "rail-move-to-start");
    expect(start.icon).toBe("arrow-left");
    // The layout changes after the menu was built: the row acts on the new one.
    click(byId(serverItems("b.example", "row", ctx), "rail-move-left"));
    click(start);
    expect(order()).toEqual(["d.example", "b.example", "a.example", "f1"]);
    click(byId(folderItems(work, "more", ctx), "rail-move-to-start"));
    expect(order()).toEqual(["f1", "d.example", "b.example", "a.example"]);
    // Already first: nothing is written.
    const before = localStorage.getItem(RAIL_LAYOUT_KEY);
    click(byId(folderItems(work, "more", ctx), "rail-move-to-start"));
    expect(localStorage.getItem(RAIL_LAYOUT_KEY)).toBe(before);
    expect(
      serverItems("d.example", "row", ctx).some((i) => i.testId === "rail-move-to-start"),
    ).toBe(false);
  });

  it("Move to {folder} lists one row per folder in layout order (empty names as Folder) and moves the server into it", async () => {
    await mount([
      { kind: "server", host: "a.example" },
      work,
      { kind: "server", host: "b.example" },
      unnamed,
    ]);
    const items = serverItems("b.example", "row", ctx);
    const rows = items.filter((i) => i.testId?.startsWith("rail-move-to-folder-") === true);
    expect(rows.map((r) => [r.testId, r.label, r.icon])).toEqual([
      ["rail-move-to-folder-0", serverRailText("moveToFolder", { name: "Work" }), "folder-plus"],
      ["rail-move-to-folder-1", serverRailText("moveToFolder", { name: "Folder" }), "folder-plus"],
    ]);
    expect(folderName(unnamed)).toBe("Folder");
    expect(serverItems("b.example", "more", ctx).map((i) => i.testId)).toContain(
      "rail-move-to-folder-1",
    );
    expect(serverItems("b.example", "servers", ctx).map((i) => i.testId)).toContain(
      "rail-move-to-folder-0",
    );
    // A member has no Move to rows.
    expect(
      serverItems("c.example", "member", ctx).some((i) => i.testId?.startsWith("rail-move-to")),
    ).toBe(false);
    click(rows[1]!);
    expect(stored()).toMatchObject([
      { host: "a.example" },
      { id: "f1", hosts: ["c.example"] },
      { id: "f2", hosts: ["d.example", "b.example"] },
    ]);
  });

  it("no options: the shared builders return Classic's menus", async () => {
    await mount([
      { kind: "server", host: "a.example" },
      work,
      { kind: "server", host: "b.example" },
    ]);
    const server = serverMenu("a.example", ctl.mutations);
    expect(server.map((i) => [i.testId, i.label, i.icon])).toEqual([
      ["rail-move-up", serverRailText("moveUp"), "arrow-up"],
      ["rail-move-down", serverRailText("moveDown"), "arrow-down"],
    ]);
    const folder = folderMenu(work, ctl.mutations);
    expect(folder.map((i) => [i.testId, i.label, i.icon])).toEqual([
      [undefined, serverRailText("collapse"), "chevron-up"],
      ["rail-rename-folder", serverRailText("renameFolder"), "pencil"],
      ["rail-folder-color", serverRailText("folderColor"), "palette"],
      [undefined, serverRailText("moveUp"), "arrow-up"],
      [undefined, serverRailText("moveDown"), "arrow-down"],
      ["rail-ungroup", serverRailText("ungroup"), "folder-minus"],
    ]);
  });
});
