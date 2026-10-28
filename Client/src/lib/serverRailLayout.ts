/**
 * Server rail layout: the order of the saved servers in the left rail and the
 * folders grouping them. Pure functions over an immutable layout, plus a
 * validated localStorage round trip. The layout is global (not per server) and
 * only names hosts; `reconcile` keeps it in step with the saved profiles.
 */

import { loadStoredJson, saveStoredJson } from "./preferences";

export type RailItem =
  | { readonly kind: "server"; readonly host: string }
  | {
      readonly kind: "folder";
      readonly id: string;
      readonly name: string;
      readonly color: string;
      readonly collapsed: boolean;
      readonly hosts: readonly string[];
    };

export type RailLayout = readonly RailItem[];

/** A top-level item: a loose server or a folder. */
export type ItemRef =
  | { readonly kind: "server"; readonly host: string }
  | { readonly kind: "folder"; readonly id: string };

/**
 * Where a moved server or folder lands. `before`/`after` a server that sits
 * inside a folder place it in that folder; `into` appends (or inserts at
 * `index`) in a folder.
 */
export type Placement =
  | { readonly type: "before" | "after"; readonly ref: ItemRef }
  | { readonly type: "into"; readonly folderId: string; readonly index?: number };

export const RAIL_LAYOUT_KEY = "owncord:server-rail-layout";
export const FOLDER_NAME_MAX = 32;
export const FOLDER_COLORS: readonly string[] = [
  "#5865f2",
  "#3ba55d",
  "#faa61a",
  "#ed4245",
  "#eb459e",
  "#747f8d",
];
const DEFAULT_COLOR: string = FOLDER_COLORS[0] ?? "#5865f2";

type FolderItem = Extract<RailItem, { kind: "folder" }>;

function isFolder(item: RailItem): item is FolderItem {
  return item.kind === "folder";
}

function sameRef(item: RailItem, ref: ItemRef): boolean {
  return ref.kind === "server"
    ? item.kind === "server" && item.host === ref.host
    : item.kind === "folder" && item.id === ref.id;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every host the layout names, in display order. */
export function layoutHosts(layout: RailLayout): string[] {
  const out: string[] = [];
  for (const item of layout) {
    if (item.kind === "server") out.push(item.host);
    else out.push(...item.hosts);
  }
  return out;
}

/** The folder holding `host`, or null for a loose (or unknown) server. */
export function folderOf(layout: RailLayout, host: string): FolderItem | null {
  for (const item of layout) {
    if (isFolder(item) && item.hosts.includes(host)) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Bring a stored layout in step with the saved profile hosts: drop hosts that
 * are no longer saved, drop duplicates (first wins), drop empty folders and
 * append newly saved hosts at the end. One-server folders are kept.
 */
export function reconcile(layout: RailLayout, profileHosts: readonly string[]): RailLayout {
  const saved = new Set(profileHosts);
  const seen = new Set<string>();
  const out: RailItem[] = [];
  const take = (host: string): boolean => {
    if (!saved.has(host) || seen.has(host)) return false;
    seen.add(host);
    return true;
  };
  const folderIds = new Set<string>();
  for (const item of layout) {
    if (item.kind === "server") {
      if (take(item.host)) out.push(item);
      continue;
    }
    if (folderIds.has(item.id)) continue;
    folderIds.add(item.id);
    const hosts = item.hosts.filter(take);
    if (hosts.length > 0) out.push({ ...item, hosts });
  }
  for (const host of profileHosts) {
    if (take(host)) out.push({ kind: "server", host });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Drop folders a move left empty. */
function prune(items: readonly RailItem[]): RailItem[] {
  return items.filter((i) => i.kind === "server" || i.hosts.length > 0);
}

function withoutServer(layout: RailLayout, host: string): RailItem[] {
  return prune(
    layout
      .filter((i) => !(i.kind === "server" && i.host === host))
      .map((i) => (isFolder(i) ? { ...i, hosts: i.hosts.filter((h) => h !== host) } : i)),
  );
}

function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  const copy = list.slice();
  copy.splice(Math.max(0, Math.min(index, copy.length)), 0, value);
  return copy;
}

/** Move a server before/after an item, or into a folder. Unknown input is a no-op. */
export function moveServer(layout: RailLayout, host: string, to: Placement): RailLayout {
  if (!layoutHosts(layout).includes(host)) return layout;
  if (to.type !== "into" && to.ref.kind === "server" && to.ref.host === host) return layout;
  const rest = withoutServer(layout, host);

  if (to.type === "into") {
    if (!rest.some((i) => isFolder(i) && i.id === to.folderId)) return layout;
    return rest.map((i) =>
      isFolder(i) && i.id === to.folderId
        ? { ...i, hosts: insertAt(i.hosts, to.index ?? i.hosts.length, host) }
        : i,
    );
  }

  const offset = to.type === "after" ? 1 : 0;
  if (to.ref.kind === "server") {
    const targetHost = to.ref.host;
    const holder = rest.findIndex((i) => isFolder(i) && i.hosts.includes(targetHost));
    if (holder >= 0) {
      return rest.map((i, idx) => {
        if (idx !== holder || !isFolder(i)) return i;
        return { ...i, hosts: insertAt(i.hosts, i.hosts.indexOf(targetHost) + offset, host) };
      });
    }
  }
  const at = rest.findIndex((i) => sameRef(i, to.ref));
  if (at < 0) return layout;
  return insertAt(rest, at + offset, { kind: "server", host });
}

/** Take a server out of its folder and put it right after that folder. */
export function moveOutOfFolder(layout: RailLayout, host: string): RailLayout {
  const folder = folderOf(layout, host);
  if (folder === null) return layout;
  const rest = withoutServer(layout, host);
  const at = rest.findIndex((i) => isFolder(i) && i.id === folder.id);
  return insertAt(rest, at < 0 ? rest.length : at + 1, { kind: "server", host });
}

/**
 * Drop `dragged` on `target`: both become a new folder (named `id`) where the
 * target was. A target already in a folder takes the dragged server into it.
 */
export function groupServers(
  layout: RailLayout,
  dragged: string,
  target: string,
  id: string,
): RailLayout {
  if (dragged === target) return layout;
  const hosts = layoutHosts(layout);
  if (!hosts.includes(dragged) || !hosts.includes(target)) return layout;
  const targetFolder = folderOf(layout, target);
  if (targetFolder !== null) {
    return moveServer(layout, dragged, { type: "after", ref: { kind: "server", host: target } });
  }
  const rest = withoutServer(layout, dragged);
  const at = rest.findIndex((i) => i.kind === "server" && i.host === target);
  if (at < 0) return layout;
  const folder: RailItem = {
    kind: "folder",
    id,
    name: "",
    color: DEFAULT_COLOR,
    collapsed: false,
    hosts: [target, dragged],
  };
  return rest.map((i, idx) => (idx === at ? folder : i));
}

/** Group a server with the one that follows it (the keyboard alternative to a drop). */
export function groupWithNext(layout: RailLayout, host: string, id: string): RailLayout {
  const index = layout.findIndex((i) => i.kind === "server" && i.host === host);
  const next = layout[index + 1];
  if (index < 0 || next === undefined || next.kind !== "server") return layout;
  return groupServers(layout, host, next.host, id);
}

function mapFolder(layout: RailLayout, id: string, fn: (f: FolderItem) => FolderItem): RailLayout {
  return layout.map((i) => (isFolder(i) && i.id === id ? fn(i) : i));
}

export function renameFolder(layout: RailLayout, id: string, name: string): RailLayout {
  const clean = name.trim().slice(0, FOLDER_NAME_MAX);
  return mapFolder(layout, id, (f) => ({ ...f, name: clean }));
}

export function setFolderColor(layout: RailLayout, id: string, color: string): RailLayout {
  if (!FOLDER_COLORS.includes(color)) return layout;
  return mapFolder(layout, id, (f) => ({ ...f, color }));
}

export function toggleCollapsed(layout: RailLayout, id: string): RailLayout {
  return mapFolder(layout, id, (f) => ({ ...f, collapsed: !f.collapsed }));
}

/** Dissolve a folder; its servers take its place in order. */
export function ungroupFolder(layout: RailLayout, id: string): RailLayout {
  return layout.flatMap((i): RailItem[] =>
    isFolder(i) && i.id === id ? i.hosts.map((host) => ({ kind: "server", host })) : [i],
  );
}

/** Move a top-level item before/after another top-level item. */
export function moveItem(
  layout: RailLayout,
  ref: ItemRef,
  to: ItemRef,
  after: boolean,
): RailLayout {
  const moving = layout.find((i) => sameRef(i, ref));
  if (moving === undefined) return layout;
  if (ref.kind === to.kind && sameRef(moving, to)) return layout;
  const rest = layout.filter((i) => i !== moving);
  const at = rest.findIndex((i) => sameRef(i, to));
  if (at < 0) return layout;
  return insertAt(rest, at + (after ? 1 : 0), moving);
}

/**
 * Move an item one step up (-1) or down (+1) where it sits: a loose server or
 * folder among the top level, a foldered server within its folder.
 */
export function shiftItem(layout: RailLayout, ref: ItemRef, delta: -1 | 1): RailLayout {
  if (ref.kind === "server") {
    const folder = folderOf(layout, ref.host);
    if (folder !== null) {
      const from = folder.hosts.indexOf(ref.host);
      const to = from + delta;
      if (to < 0 || to >= folder.hosts.length) return layout;
      const hosts = folder.hosts.slice();
      hosts.splice(from, 1);
      hosts.splice(to, 0, ref.host);
      return mapFolder(layout, folder.id, (f) => ({ ...f, hosts }));
    }
  }
  const from = layout.findIndex((i) => sameRef(i, ref));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= layout.length) return layout;
  const copy = layout.slice();
  const [moved] = copy.splice(from, 1);
  if (moved === undefined) return layout;
  copy.splice(to, 0, moved);
  return copy;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
}

/** Validate untrusted JSON into a layout; null when any part is malformed. */
export function parseLayout(raw: unknown): RailLayout | null {
  if (!Array.isArray(raw)) return null;
  const out: RailItem[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (e["kind"] === "server") {
      if (typeof e["host"] !== "string" || e["host"] === "") return null;
      out.push({ kind: "server", host: e["host"] });
    } else if (e["kind"] === "folder") {
      const { id, name, color, collapsed, hosts } = e;
      if (typeof id !== "string" || id === "") return null;
      if (typeof name !== "string" || typeof collapsed !== "boolean") return null;
      if (typeof color !== "string" || !isStringArray(hosts)) return null;
      out.push({
        kind: "folder",
        id,
        name: name.slice(0, FOLDER_NAME_MAX),
        color: FOLDER_COLORS.includes(color) ? color : DEFAULT_COLOR,
        collapsed,
        hosts,
      });
    } else {
      return null;
    }
  }
  return out;
}

/** The saved layout; bad or unreadable data gives the default (empty) layout. */
export function loadLayout(): RailLayout {
  return loadStoredJson(
    RAIL_LAYOUT_KEY,
    (value) => {
      const parsed = parseLayout(value);
      if (parsed === null) throw new Error(RAIL_LAYOUT_KEY); // i18n-exempt: never shown
      return parsed;
    },
    [],
  );
}

/** Persist the layout; a blocked or full store keeps it for this session only. */
export function saveLayout(layout: RailLayout): void {
  saveStoredJson(RAIL_LAYOUT_KEY, layout);
}

/** Letters shown on a server icon: word initials ("My Cool Server" -> "MCS"), else two letters. */
export function serverInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return "?";
  const letters =
    words.length === 1
      ? Array.from(words[0] ?? "").slice(0, 2)
      : words.slice(0, 3).map((w) => Array.from(w)[0] ?? "");
  return letters.join("").toUpperCase();
}
