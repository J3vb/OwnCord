// The rail's context menus and drop handling, as plain functions over the
// layout operations the rail hands in.
import type { ContextMenuItem } from "@lib/ui/contextMenu";
import { COLOR_NAME_KEYS, type DropZone } from "./serverRailParts";
import {
  FOLDER_COLORS,
  folderOf,
  groupServers,
  groupWithNext,
  moveItem,
  moveOutOfFolder,
  moveServer,
  setFolderColor,
  shiftItem,
  toggleCollapsed,
  ungroupFolder,
  type ItemRef,
  type RailItem,
  type RailLayout,
} from "@lib/prefs/serverRailLayout";
import { serverRailText } from "../../i18n/serverRail";

/** What the menus and drops need from the rail that owns the layout. */
export interface RailMutations {
  readonly reconciled: () => RailLayout;
  readonly commit: (next: RailLayout) => void;
  readonly newFolderId: () => string;
  readonly promptRename: (folder: Extract<RailItem, { kind: "folder" }>) => void;
}

/** How a renderer draws the shared menus; Classic passes none. */
export interface MenuOptions {
  /** "x": Move left / Move right, test ids rail-move-left / rail-move-right; "y" (default): Move up / Move down, as today. */
  readonly axis?: "x" | "y";
  /** False drops Expand/Collapse from a folder's menu (default true). */
  readonly collapsible?: boolean;
}

/** The two move rows of an item, along the axis it is drawn on. */
function moveItems(
  commit: RailMutations["commit"],
  current: RailLayout,
  ref: ItemRef,
  opts: MenuOptions,
  withIds: boolean,
): ContextMenuItem[] {
  const x = opts.axis === "x";
  const back: ContextMenuItem = {
    label: serverRailText(x ? "moveLeft" : "moveUp"),
    icon: x ? "arrow-left" : "arrow-up",
    onClick: () => commit(shiftItem(current, ref, -1)),
  };
  const forward: ContextMenuItem = {
    label: serverRailText(x ? "moveRight" : "moveDown"),
    icon: x ? "arrow-right" : "arrow-down",
    onClick: () => commit(shiftItem(current, ref, 1)),
  };
  if (!withIds && !x) return [back, forward];
  return [
    { ...back, testId: x ? "rail-move-left" : "rail-move-up" },
    { ...forward, testId: x ? "rail-move-right" : "rail-move-down" },
  ];
}

/** The context menu of one server icon. */
export function serverMenu(
  host: string,
  deps: RailMutations,
  opts: MenuOptions = {},
): ContextMenuItem[] {
  const { reconciled, commit, newFolderId } = deps;
  const current = reconciled();
  const ref: ItemRef = { kind: "server", host };
  const items: ContextMenuItem[] = moveItems(commit, current, ref, opts, true);
  if (folderOf(current, host) !== null) {
    items.push({
      label: serverRailText("removeFromFolder"),
      testId: "rail-remove-from-folder",
      icon: "folder-minus",
      onClick: () => commit(moveOutOfFolder(current, host)),
    });
  } else {
    const index = current.findIndex((i) => i.kind === "server" && i.host === host);
    const next = current[index + 1];
    if (next !== undefined && next.kind === "server") {
      items.push({
        label: serverRailText("groupNext"),
        testId: "rail-group-next",
        icon: "folder-plus",
        onClick: () => commit(groupWithNext(current, host, newFolderId())),
      });
    }
  }
  return items;
}

/** The context menu of one folder icon. */
export function folderMenu(
  folder: Extract<RailItem, { kind: "folder" }>,
  deps: RailMutations,
  opts: MenuOptions = {},
): ContextMenuItem[] {
  const { reconciled, commit, promptRename } = deps;
  const current = reconciled();
  const ref: ItemRef = { kind: "folder", id: folder.id };
  const toggle: ContextMenuItem[] =
    opts.collapsible === false
      ? []
      : [
          {
            label: folder.collapsed ? serverRailText("expand") : serverRailText("collapse"),
            icon: folder.collapsed ? "chevron-down" : "chevron-up",
            onClick: () => commit(toggleCollapsed(current, folder.id)),
          },
        ];
  return [
    ...toggle,
    {
      label: serverRailText("renameFolder"),
      testId: "rail-rename-folder",
      icon: "pencil",
      onClick: () => promptRename(folder),
    },
    {
      label: serverRailText("folderColor"),
      testId: "rail-folder-color",
      icon: "palette",
      onClick: () => {},
      submenu: FOLDER_COLORS.map((color, i) => ({
        label: serverRailText(COLOR_NAME_KEYS[i] ?? "color.grey"),
        checked: folder.color === color,
        radio: true,
        testId: `rail-color-${i}`,
        onClick: () => commit(setFolderColor(current, folder.id, color)),
      })),
    },
    ...moveItems(commit, current, ref, opts, false),
    {
      label: serverRailText("ungroup"),
      testId: "rail-ungroup",
      icon: "folder-minus",
      onClick: () => commit(ungroupFolder(current, folder.id)),
    },
  ];
}

/** Apply a drop of `from` onto `target`: a move, a regroup or a new folder. */
export function applyDrop(
  from: ItemRef,
  target: ItemRef,
  zone: DropZone,
  deps: RailMutations,
): void {
  const { reconciled, commit, newFolderId } = deps;
  const current = reconciled();
  if (from.kind === "server") {
    if (target.kind === "server") {
      if (zone === "into") {
        commit(groupServers(current, from.host, target.host, newFolderId()));
      } else {
        commit(moveServer(current, from.host, { type: zone, ref: target }));
      }
    } else if (zone === "into") {
      commit(moveServer(current, from.host, { type: "into", folderId: target.id }));
    } else {
      commit(moveServer(current, from.host, { type: zone, ref: target }));
    }
    return;
  }
  // A folder only moves among the top-level items.
  let anchor: ItemRef = target;
  if (target.kind === "server") {
    const holder = folderOf(current, target.host);
    if (holder !== null) anchor = { kind: "folder", id: holder.id };
  }
  commit(moveItem(current, from, anchor, zone === "after" || zone === "into"));
}
