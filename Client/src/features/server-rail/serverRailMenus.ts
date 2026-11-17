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

/** The context menu of one server icon. */
export function serverMenu(host: string, deps: RailMutations): ContextMenuItem[] {
  const { reconciled, commit, newFolderId } = deps;
  const current = reconciled();
  const ref: ItemRef = { kind: "server", host };
  const items: ContextMenuItem[] = [
    {
      label: serverRailText("moveUp"),
      testId: "rail-move-up",
      icon: "arrow-up",
      onClick: () => commit(shiftItem(current, ref, -1)),
    },
    {
      label: serverRailText("moveDown"),
      testId: "rail-move-down",
      icon: "arrow-down",
      onClick: () => commit(shiftItem(current, ref, 1)),
    },
  ];
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
): ContextMenuItem[] {
  const { reconciled, commit, promptRename } = deps;
  const current = reconciled();
  const ref: ItemRef = { kind: "folder", id: folder.id };
  return [
    {
      label: folder.collapsed ? serverRailText("expand") : serverRailText("collapse"),
      icon: folder.collapsed ? "chevron-down" : "chevron-up",
      onClick: () => commit(toggleCollapsed(current, folder.id)),
    },
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
    {
      label: serverRailText("moveUp"),
      icon: "arrow-up",
      onClick: () => commit(shiftItem(current, ref, -1)),
    },
    {
      label: serverRailText("moveDown"),
      icon: "arrow-down",
      onClick: () => commit(shiftItem(current, ref, 1)),
    },
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
