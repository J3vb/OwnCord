/**
 * Icons in the DM, thread, category, voice volume, image, server rail and
 * camera menus: every action row leads with one (both labels of a toggled
 * row), destructive rows keep their danger class, and a row that is a control
 * (the volume slider) stays as it was while the rows around it line up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const getUserVolume = vi.fn((..._args: unknown[]) => 100);

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    setUserVolume: vi.fn(),
    getUserVolume: (...args: unknown[]) => getUserVolume(...args) as unknown,
    setUserLocalMute: vi.fn(),
    getUserLocalMute: () => false,
    switchVideoDevice: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeCameraDevices: () =>
    Promise.resolve([
      { deviceId: "a", label: "Front" },
      { deviceId: "b", label: "Back" },
    ]),
}));

import {
  openDmContextMenu,
  type DmMenuActions,
  type DmMenuConvo,
} from "../../src/features/direct-messages/dmContextMenu";
import { attachThreadContextMenu } from "../../src/features/channels/sidebar/threadMenu";
import { attachCategoryContextMenu } from "../../src/features/channels/sidebar/categoryMenu";
import {
  appendVoiceModeration,
  showUserVolumeMenu,
  type VoiceModMenuOptions,
} from "../../src/features/channels/sidebar/volumeMenu";
import { openImageMenu, closeImageMenu } from "../../src/features/messaging/message-list/imageMenu";
import { folderMenu, serverMenu } from "../../src/features/server-rail/serverRailMenus";
import { showCameraMenu } from "../../src/features/voice/cameraMenu";
import { blocksStore } from "@stores/blocks.store";
import { isCategoryCollapsed, toggleCategory } from "@stores/ui.store";
import type { ContextMenuItem } from "@lib/ui/contextMenu";
import type { RailItem, RailLayout } from "@lib/prefs/serverRailLayout";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";
import { menuRowLabel } from "../helpers/menuRowLabel";
import { signInAs } from "../helpers/storeSeeds";

let ac: AbortController;

const slotOf = (row: Element): HTMLElement | null =>
  row.querySelector<HTMLElement>(":scope > .menu-item-icon");
const iconOf = (row: Element): string | null =>
  slotOf(row)?.querySelector("svg")?.getAttribute("data-icon") ?? null;
const byId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
/** The action rows of the open menu (not its flyouts), as testId → icon. */
function iconsOf(menu: Element): Record<string, string | null> {
  const rows = [...menu.querySelectorAll<HTMLElement>(":scope > [role^='menuitem']")];
  return Object.fromEntries(rows.map((r) => [r.dataset["testid"] ?? menuRowLabel(r), iconOf(r)]));
}

beforeEach(() => {
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  closeImageMenu();
  setDeveloperMode(false);
  blocksStore.setState((s) => ({ ...s, blockedByMe: new Set() }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.replaceChildren();
});

describe("DM row menu icons", () => {
  const convo = (o: Partial<DmMenuConvo> = {}): DmMenuConvo => ({
    channelId: 7,
    userId: 9,
    username: "Bob",
    isGroup: false,
    unread: true,
    muted: false,
    mutedUntil: null,
    ...o,
  });
  const actions: DmMenuActions = {
    onCloseDm: vi.fn(),
    onSetMute: vi.fn(),
    onMuteFor: vi.fn(),
    onMarkRead: vi.fn(),
    onOpenProfile: vi.fn(),
    onCall: vi.fn(),
    onToggleBlock: vi.fn(),
    onRenameGroup: vi.fn(),
    onChangeGroupIcon: vi.fn(),
    onRemoveGroupIcon: vi.fn(),
  };
  const open = (c: DmMenuConvo): HTMLElement => {
    openDmContextMenu({ convo: c, actions, confirmLeave: vi.fn(), x: 0, y: 0, signal: ac.signal });
    return document.querySelector<HTMLElement>(".dm-context-menu")!;
  };

  it("gives every row of a 1:1 DM an icon, Block and Close kept red", () => {
    setDeveloperMode(true);
    expect(iconsOf(open(convo()))).toEqual({
      "dm-mark-read-7": "check-check",
      "dm-profile-7": "user",
      "dm-call-7": "phone",
      "dm-mute-7": "bell-off",
      "dm-block-7": "user-x",
      "dm-copy-id-7": "copy",
      "dm-close-7": "x",
    });
    expect(byId("dm-block-7").classList).toContain("danger");
    expect(byId("dm-close-7").classList).toContain("danger");
    // The timed choices in the Mute flyout stay a plain list.
    expect(document.querySelector(".context-menu__submenu .menu-item-icon svg")).toBeNull();
  });

  it("swaps the toggled rows' icons with their labels: Unmute and Unblock", () => {
    blocksStore.setState((s) => ({ ...s, blockedByMe: new Set([9]) }));
    open(convo({ muted: true, unread: false }));
    expect(menuRowLabel(byId("dm-mute-7"))).toBe("Unmute Conversation");
    expect(iconOf(byId("dm-mute-7"))).toBe("bell");
    expect(menuRowLabel(byId("dm-block-7"))).toBe("Unblock");
    expect(iconOf(byId("dm-block-7"))).toBe("user");
    expect(byId("dm-block-7").classList).not.toContain("danger");
  });

  it("gives the group rows icons, Leave Group kept red", () => {
    expect(iconsOf(open(convo({ isGroup: true, hasOwner: true, hasIcon: true })))).toEqual({
      "dm-mark-read-7": "check-check",
      "dm-mute-7": "bell-off",
      "dm-rename-7": "pencil",
      "dm-change-icon-7": "image",
      "dm-remove-icon-7": "trash-2",
      "dm-close-7": "log-out",
    });
    expect(byId("dm-close-7").classList).toContain("danger");
  });
});

describe("thread and category menu icons", () => {
  it("gives the thread row's menu icons, the disabled Mark as Read included", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const hasUnread = vi.fn(() => false);
    attachThreadContextMenu(
      el,
      { hasUnread, onMarkRead: vi.fn(), onUnfollow: vi.fn() },
      ac.signal,
      ac.signal,
    );
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(iconsOf(byId("thread-context-menu"))).toEqual({
      "ctx-thread-mark-read": "check-check",
      "ctx-thread-unfollow": "bell-off",
    });
    expect(byId("ctx-thread-mark-read").getAttribute("aria-disabled")).toBe("true");
  });

  function openCategoryMenu(key: string): HTMLElement {
    const header = document.createElement("div");
    document.body.appendChild(header);
    attachCategoryContextMenu(
      header,
      header,
      { key, id: 4, name: key },
      {
        onCreateCategory: vi.fn(),
        onRenameCategory: vi.fn(),
        onDeleteCategory: vi.fn(),
        onMoveCategory: vi.fn(),
      },
      ac.signal,
      ac.signal,
    );
    header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    return byId("category-context-menu");
  }

  it("gives every category row an icon, Delete kept red, for a manager", () => {
    signInAs({ id: 1, username: "o", avatar: null, role: "owner" });
    expect(iconsOf(openCategoryMenu("IconsA"))).toEqual({
      "ctx-category-mark-read": "check-check",
      "ctx-category-toggle": "chevron-up",
      "ctx-category-collapse-all": "chevrons-down-up",
      "ctx-category-create": "folder-plus",
      "ctx-category-rename": "pencil",
      "ctx-category-move-up": "arrow-up",
      "ctx-category-move-down": "arrow-down",
      "ctx-category-delete": "trash-2",
    });
    expect(byId("ctx-category-delete").classList).toContain("danger");
  });

  it("shows Expand with its own icon on a collapsed category", () => {
    if (!isCategoryCollapsed("IconsB")) toggleCategory("IconsB");
    openCategoryMenu("IconsB");
    expect(menuRowLabel(byId("ctx-category-toggle"))).toBe("Expand Category");
    expect(iconOf(byId("ctx-category-toggle"))).toBe("chevron-down");
    toggleCategory("IconsB");
  });
});

describe("voice volume menu icons", () => {
  const mod = (o: Partial<VoiceModMenuOptions> = {}): VoiceModMenuOptions => ({
    moveTargets: [{ id: 2, name: "Lounge" }],
    onServerMute: vi.fn(),
    onServerDeafen: vi.fn(),
    onMove: vi.fn(),
    onDisconnect: vi.fn(),
    ...o,
  });
  const menu = (): HTMLElement => document.querySelector<HTMLElement>(".user-vol-menu")!;
  const action = (name: string): HTMLElement =>
    menu().querySelector<HTMLElement>(`[data-action="${name}"]`)!;

  it("leaves the slider untouched and lines every row up beside the action rows", () => {
    showUserVolumeMenu(5, "Ann", 0, 0, ac.signal, mod());
    const slider = menu().querySelector<HTMLInputElement>("input[type=range]")!;
    const sliderRow = slider.parentElement!;
    expect(sliderRow.parentElement).toBe(menu());
    expect(sliderRow.querySelector(".menu-item-icon")).toBeNull();
    expect([...sliderRow.children].map((c) => c.tagName)).toEqual(["INPUT", "SPAN"]);
    // The name and the level line are text, not actions: an empty slot each.
    const [name, level] = menu().querySelectorAll<HTMLElement>(":scope > div.context-menu-item");
    expect(slotOf(name!)!.childElementCount).toBe(0);
    expect(slotOf(level!)!.childElementCount).toBe(0);
    expect(iconOf(menu().querySelector('[role="menuitem"]:not([data-action])')!)).toBe("volume-2");
    expect(iconOf(action("local-mute"))).toBe("volume-x");
    expect(action("local-mute").getAttribute("aria-checked")).toBe("false");

    slider.value = "40";
    slider.dispatchEvent(new Event("input"));
    expect(level!.textContent).toBe("User Volume: 40%");
    expect(slotOf(level!)).not.toBeNull();
  });

  it("gives both labels of each moderation toggle an icon, Disconnect kept red", () => {
    showUserVolumeMenu(5, "Ann", 0, 0, ac.signal, mod());
    expect(iconOf(action("server-mute"))).toBe("mic-off");
    expect(iconOf(action("server-deafen"))).toBe("headphones-off");
    expect(iconOf(action("move-to"))).toBe("arrow-right");
    expect(iconOf(action("voice-disconnect"))).toBe("phone-off");
    expect(action("voice-disconnect").classList).toContain("danger");
    expect(menu().querySelector("[data-move-channel] .menu-item-icon")).toBeNull();
    ac.abort();
    document.body.replaceChildren();

    ac = new AbortController();
    showUserVolumeMenu(5, "Ann", 0, 0, ac.signal, mod({ serverMuted: true, serverDeafened: true }));
    expect(menuRowLabel(action("server-mute"))).toBe("Server Unmute");
    expect(iconOf(action("server-mute"))).toBe("mic");
    expect(iconOf(action("server-deafen"))).toBe("headphones");
  });

  it("keeps the shared moderation rows plain where the caller asks for no icons", () => {
    const host = document.createElement("div");
    appendVoiceModeration(host, mod(), vi.fn());
    expect(host.querySelector(".menu-item-icon")).toBeNull();
  });
});

describe("image, server rail and camera menu icons", () => {
  it("gives every image menu row an icon", () => {
    const img = document.createElement("img");
    document.body.appendChild(img);
    openImageMenu(0, 0, { img, link: "https://example.com/a.png", save: vi.fn() });
    expect(iconsOf(document.querySelector(".image-context-menu")!)).toEqual({
      "image-menu-copy": "copy",
      "image-menu-copy-link": "link",
      "image-menu-open-link": "external-link",
      "image-menu-save": "download",
    });
  });

  const folder: Extract<RailItem, { kind: "folder" }> = {
    kind: "folder",
    id: "f1",
    name: "F",
    color: "#99aab5",
    collapsed: false,
    hosts: ["a"],
  };
  const icons = (items: readonly ContextMenuItem[]): (string | undefined)[] =>
    items.map((i) => i.icon);
  const deps = (layout: RailLayout) => ({
    reconciled: () => layout,
    commit: vi.fn(),
    newFolderId: () => "f2",
    promptRename: vi.fn(),
  });

  it("gives every server icon menu row an icon, inside a folder or not", () => {
    const loose: RailLayout = [
      { kind: "server", host: "a" },
      { kind: "server", host: "b" },
    ];
    expect(icons(serverMenu("a", deps(loose)))).toEqual(["arrow-up", "arrow-down", "folder-plus"]);
    expect(icons(serverMenu("a", deps([folder])))).toEqual([
      "arrow-up",
      "arrow-down",
      "folder-minus",
    ]);
  });

  it("gives every folder menu row an icon, Collapse and Expand each their own", () => {
    const layout: RailLayout = [folder];
    const open = folderMenu(folder, deps(layout));
    expect(icons(open)).toEqual([
      "chevron-up",
      "pencil",
      "palette",
      "arrow-up",
      "arrow-down",
      "folder-minus",
    ]);
    // The colour choices are a radio list, without icons.
    expect(icons(open[2]!.submenu ?? []).every((i) => i === undefined)).toBe(true);
    const shut = folderMenu({ ...folder, collapsed: true }, deps(layout));
    expect(shut[0]!.icon).toBe("chevron-down");
  });

  it("leads each camera row with the camera icon, keeping its check", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    await showCameraMenu(anchor, ac.signal);
    for (const i of [0, 1, 2]) {
      const row = byId(`camera-device-${i}`);
      expect(iconOf(row)).toBe("camera");
      expect(row.getAttribute("role")).toBe("menuitemcheckbox");
    }
    expect(menuRowLabel(byId("camera-device-1"))).toBe("Front");
    expect(byId("camera-device-0").getAttribute("aria-checked")).toBe("true");
  });
});
