/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (force logout, ban, role change).
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement } from "@lib/dom";
import { reconcileModels } from "@lib/net/reconcile";
import { select } from "@lib/select";
import { shallowEqual } from "@lib/store";
import { buildOffsets, rangeFor } from "@lib/virtualRange";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { MountableComponent } from "@lib/text/safeRender";
import { Disposable } from "@lib/disposable";
import { resolveDisplayName } from "@lib/avatar";
import { membersStore, memberDisplayName, type Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore } from "@stores/channels.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";
import { withMemberMenu } from "./member-menu-loader";
import { createAvatarElement, pickAvatarColor } from "./message-list/avatar";
import { assignableRoleNames, outranksPosition } from "../features/moderation/roleAssignment";
import { memberTimeoutsStore } from "../features/moderation/store";
import { canMention, mentionInComposer } from "../features/messaging/activeComposer";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
import { openMenuOnKeyboard, type OpenMenu } from "@lib/context-menu";
import { Permission, type ReadyRole } from "@lib/types";
import { manageNicknamesEnabled, multiRoleEnabled } from "@lib/net/serverCapabilities";
import { memberHasPermissionIn, topPositionFor } from "@lib/permissions";
import {
  MEMBER_PATCH_FIELDS,
  drawMemberItem,
  patchMemberItem,
  type MemberItemModel,
} from "../features/members/memberRow.view";
import { shellText } from "../i18n/shell";
import { rowActivity } from "../features/members/listeningLine";
import {
  buildModel,
  flattenModel,
  isAwayStatus,
  updateModel,
  type ListItem,
  type MemberModel,
} from "../features/members/memberModel";

/** Options for configuring admin action callbacks on the member list. */
export interface MemberListOptions {
  /** Role name of the signed-in user; resolved against the server's role list
   *  to get the permission mask that gates the moderation menu items. */
  readonly currentUserRole: string;
  /** Force logout: revokes the target's sessions (KICK_MEMBERS). */
  readonly onKick: (userId: number, username: string) => Promise<void>;
  /** Open the Ban dialog for a member; `displayName` names them in its title. */
  readonly onBan: (userId: number, username: string, displayName: string) => void;
  readonly onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
  /** Open the Change Nickname dialog (MANAGE_NICKNAMES); `current` is the
   *  member's nickname now, null when they have none. Absent hides the item. */
  readonly onChangeNickname?: (userId: number, username: string, current: string | null) => void;
  /** Add / remove one role from the profile popup's chips. */
  readonly onAddRole?: (userId: number, username: string, roleId: number) => Promise<void>;
  readonly onRemoveRole?: (userId: number, username: string, roleId: number) => Promise<void>;
  readonly onToggleBlock: (userId: number, username: string, block: boolean) => Promise<void>;
  /** Block / Unblock from the profile popup, which confirms a Block in a
   *  dialog (the row menu confirms inline). Omitted: the popup has no button. */
  readonly onBlockFromPopup?: (userId: number, username: string, block: boolean) => void;
  /** Start a DM with a user (wires the profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
  /** Call a user: open (or create) the 1:1 DM with them and start a call in
   *  it (wires the profile popup's Call button). */
  readonly onCallUser?: (userId: number) => void;
  /** Report a user to this server's moderators (the profile popup's Report button). */
  readonly onReportUser?: (userId: number, name: string) => void;
  /** Time a member out for `seconds` (MODERATE_MEMBERS); absent hides Timeout. */
  readonly onTimeoutMember?: (userId: number, username: string, seconds: number) => Promise<void>;
  /** End a member's timeout early; absent hides Remove Timeout. */
  readonly onRemoveTimeout?: (userId: number, username: string) => Promise<void>;
  /** Voice moderation rows for a member in a server voice channel: the options,
   *  a string saying why they are unavailable, or undefined for none. Absent
   *  hides the rows. */
  readonly voiceModFor?: (
    channelId: number,
    user: VoiceUser,
  ) => VoiceModMenuOptions | string | undefined;
}

/** Which moderation menu items the signed-in user may see. */
interface ModerationGates {
  readonly canKick: boolean;
  readonly canBan: boolean;
  readonly canManageRoles: boolean;
  readonly canTimeout: boolean;
  readonly canManageNicknames: boolean;
}

/**
 * Menu items the signed-in user's role permits, from the permission mask the
 * server ships in `ready`. Administrator implies all three. When the role name
 * has no match in that list (pre-`ready`, or an older server that sent none)
 * the legacy owner/admin name check stands in — a mask of 0 would otherwise
 * hide moderation from every actual admin.
 */
function moderationGates(
  roles: readonly ReadyRole[],
  roleIds: readonly number[] | undefined,
  roleName: string,
): ModerationGates {
  const has = (perm: Permission): boolean => memberHasPermissionIn(roles, roleIds, roleName, perm);
  return {
    canKick: has(Permission.KICK_MEMBERS),
    canBan: has(Permission.BAN_MEMBERS),
    canManageRoles: has(Permission.MANAGE_ROLES),
    canTimeout: has(Permission.MODERATE_MEMBERS),
    // The bit alone is not enough: an older server can hold it without the route.
    canManageNicknames: manageNicknamesEnabled() && has(Permission.MANAGE_NICKNAMES),
  };
}

/** Where a member is connected, when that is a server voice channel (a DM call
 *  is excluded: its participants are not moderated from the roster). */
function serverVoiceTarget(
  userId: number,
): { readonly channelId: number; readonly user: VoiceUser } | undefined {
  const channels = channelsStore.getState().channels;
  for (const [channelId, users] of voiceStore.getState().voiceUsers) {
    const user = users.get(userId);
    if (user !== undefined && channels.get(channelId)?.type === "voice") {
      return { channelId, user };
    }
  }
  return undefined;
}

/** Whether the server says the member is timed out: `unknown` when it publishes
 *  no view (an older server). An entry is the answer; the clock is never read. */
function timeoutStateOf(userId: number): "active" | "none" | "unknown" {
  const map = memberTimeoutsStore.getState();
  if (map === null) return "unknown";
  return map.has(userId) ? "active" : "none";
}

let activeMenu: OpenMenu | null = null;

/** Bumped by every open, close and list teardown. The menu module loads lazily
 *  on the first right-click; a load that finishes after a newer open or a
 *  destroy sees a changed value and renders nothing. */
let menuOpenSeq = 0;

/** Key of the row whose menu is open: the virtual list keeps that row rendered. */
let menuRowKey: string | null = null;

function closeActiveMenu(): void {
  menuOpenSeq += 1;
  menuRowKey = null;
  if (activeMenu !== null) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

/**
 * Closers for the profile popups this list opened. destroy() runs only these:
 * each is a no-op once another opener replaced its popup, so a card MessageList
 * opened stays up when the sidebar switches away from the member list.
 */
const ownPopupClosers = new Set<() => void>();

/**
 * Above this many members the list draws only the rows in view. At or below it
 * every row is in the DOM, which keeps native find and screen-reader browse
 * mode complete on small servers. Tests over this size must reach a row by
 * search or by keyboard, never by assuming every testid is rendered.
 */
const VIRTUAL_ABOVE = 200;

/** Items drawn beyond each edge of the viewport. */
const OVERSCAN = 10;

const HEADER = 0;
const ROW = 1;
const ROW_STATUS = 2;
const EMPTY = 3;

/** Starting heights per kind (margins included), until a rendered row is measured. */
const ESTIMATED_HEIGHTS: readonly number[] = [35, 42, 42, 80];

/** The height kind of a list item. */
function kindOf(item: ListItem): number {
  if (item.kind === "header") return HEADER;
  if (item.kind === "empty") return EMPTY;
  const custom = item.member.customStatus;
  const hasLine =
    (typeof custom === "string" && custom.length > 0) ||
    item.member.activity != null ||
    item.member.listening != null;
  return hasLine ? ROW_STATUS : ROW;
}

/** `kindOf` for a drawn child: the same height kind, read from its model. */
function kindOfModel(model: MemberItemModel): number {
  if (model.kind === "header") return HEADER;
  if (model.kind === "empty") return EMPTY;
  return model.customStatus === null && model.activity === null ? ROW : ROW_STATUS;
}

/** The last model the virtual list built, so a reopened column resumes from it
 *  instead of sorting again. Model only: it holds no DOM. */
let modelMemo: MemberModel | null = null;

// app-lifetime: registered once at load; the memo itself is dropped with the session.
void registerSessionReset(
  "members:model-memo",
  () => {
    modelMemo = null;
  },
  { phase: "cache" },
);

/** The model for the roster, taken from the memo when there is one. */
export function memberModelFor(
  members: ReadonlyMap<number, Member>,
  roles: readonly ReadyRole[],
): MemberModel {
  modelMemo =
    modelMemo === null ? buildModel(members, roles) : updateModel(modelMemo, members, roles);
  return modelMemo;
}

/** Whether a model is memoised. For tests. */
export function hasMemberModelMemo(): boolean {
  return modelMemo !== null;
}

/** What a row needs from the list that owns it: arrow-key moves and its own element. */
interface RowHooks {
  /** Move focus for an arrow/Home/End/Page key pressed on member `id`'s row. */
  readonly navigate: (key: string, id: number, from: HTMLElement) => void;
  /** Focus member `id`'s row (or the first row when it is gone) and return it. */
  readonly focusMember: (id: number) => HTMLElement | null;
}

/** Keys that move between member rows. */
const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  // i18n-exempt: KeyboardEvent.key value, not rendered
  "Home",
  // i18n-exempt: KeyboardEvent.key value, not rendered
  "End",
  "PageUp",
  "PageDown",
]);

/** The member a row draws, resolved into plain data for `reconcileModels`. */
function itemModel(item: ListItem): MemberItemModel {
  if (item.kind === "header") return { kind: "header", text: item.text, offline: item.offline };
  if (item.kind === "empty") return { kind: "empty", text: item.text };
  const { member } = item;
  const custom = member.customStatus;
  const customStatus = typeof custom === "string" && custom.length > 0 ? custom : null;
  // The custom status wins the line, then a game, then music; the full card
  // shows in the profile.
  const shown = customStatus === null ? rowActivity(member.activity, member.listening) : null;
  return {
    kind: "row",
    id: member.id,
    name: memberDisplayName(member),
    avatarName: resolveDisplayName({ username: member.username, displayName: member.displayName }),
    avatarColor: pickAvatarColor(member.username),
    avatarUrl: member.avatar,
    customStatus,
    activity: shown === null ? null : shown.text,
    activityIcon: shown === null ? "gamepad-2" : shown.icon,
    colorVar: item.colorVar,
    status: member.status,
    away: isAwayStatus(member.status),
  };
}

/** Add a drawn row's behaviour. Handlers read the member through `atEvent`
 *  at event time, never from the render-time model: the row is reused across
 *  store updates. */
function createMemberItem(
  item: HTMLElement,
  atEvent: () => ListItem,
  opts: MemberListOptions,
  hooks: RowHooks,
  signal: AbortSignal,
): HTMLElement {
  const liveMember = (): Member => {
    const live = atEvent();
    // i18n-exempt: developer diagnostic for a programming error, never shown
    if (live.kind !== "row") throw new Error("member row bound to a non-row item");
    return live.member;
  };

  // Left-click, Enter or Space opens the profile popup (previously dead code —
  // built and tested but never mounted from anywhere). The row is a button so
  // the profile, and its Report action, is reachable from the keyboard.
  const openProfile = (anchorX: number, anchorY: number): void => {
    closeActiveMenu();
    const member = liveMember();
    const close = openUserProfilePopup({
      userId: member.id,
      anchorX,
      anchorY,
      fallbackUser: member,
      signal,
      callbacks: {
        ...(opts.onMessageUser === undefined ? {} : { onMessage: opts.onMessageUser }),
        ...(opts.onCallUser === undefined ? {} : { onCall: opts.onCallUser }),
        ...(opts.onReportUser === undefined ? {} : { onReport: opts.onReportUser }),
        ...(opts.onBlockFromPopup === undefined ? {} : { onToggleBlock: opts.onBlockFromPopup }),
        onChangeRole: opts.onChangeRole,
        ...(opts.onAddRole === undefined ? {} : { onAddRole: opts.onAddRole }),
        ...(opts.onRemoveRole === undefined ? {} : { onRemoveRole: opts.onRemoveRole }),
      },
      fallbackFocus: () => hooks.focusMember(member.id),
    });
    ownPopupClosers.add(close);
  };
  item.addEventListener("click", (e) => openProfile(e.clientX, e.clientY), { signal });
  item.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      openProfile(rect.right, rect.top);
    },
    { signal },
  );

  // Arrow keys move between member rows. Only keys pressed on the row itself
  // count (a menu or popup lives outside it), and a modified key is left alone.
  item.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== item || !NAV_KEYS.has(e.key)) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      hooks.navigate(e.key, liveMember().id, item);
    },
    { signal },
  );

  // Context menu for admin actions. `openContextMenu` takes viewport
  // coordinates; the keyboard path (Shift+F10 / the Menu key) anchors to the
  // row's own edge instead of a pointer position.
  const openContextMenu = (clientX: number, clientY: number): void => {
    const member = liveMember();
    const isSelf = member.id === (authStore.getState().user?.id ?? 0);

    // Moderation actions are permission-gated per item (a role name told us
    // nothing about what its bits allow); block/unblock is open to everyone.
    // The role name is read live from authStore, not the opts snapshot
    // taken once at mount -- dispatcher.ts keeps authStore.user.role
    // current on every self MEMBER_UPDATE precisely so gates like this one
    // see a promotion/demotion without waiting for the sidebar to rebuild.
    const actor = authStore.getState().user;
    const actorRole = actor?.role ?? opts.currentUserRole;
    const roleList = channelsStore.getState().roles;
    // Permissions are the OR of every held role; rank is the top one.
    const baseGates = moderationGates(roleList, actor?.role_ids, actorRole);
    // The server refuses moderation of a member ranked at or above the actor
    // and any role assignment at or above the actor's own rank; mirror both so
    // the menu never offers a request that cannot succeed. Unknown positions
    // (an older server) leave the decision to the server.
    const actorPosition = topPositionFor(roleList, actor?.role_ids, actorRole);
    const targetPosition = topPositionFor(roleList, member.roleIds, member.role);
    const outranks = outranksPosition(actorPosition, targetPosition);
    // Roles come from the server's `ready` payload — a hardcoded list made
    // custom roles unreachable and, worse, unresolvable to a role id, so
    // picking one silently did nothing.
    const availableRoles = assignableRoleNames(actorPosition);
    const gates: ModerationGates = {
      canKick: baseGates.canKick && outranks,
      canBan: baseGates.canBan && outranks,
      canManageRoles: baseGates.canManageRoles && outranks && availableRoles.length > 0,
      canTimeout: baseGates.canTimeout && outranks,
      canManageNicknames: baseGates.canManageNicknames && outranks,
    };
    const showAdminActions =
      !isSelf &&
      (gates.canKick ||
        gates.canBan ||
        gates.canManageRoles ||
        gates.canTimeout ||
        gates.canManageNicknames);

    closeActiveMenu();
    const seq = menuOpenSeq;
    menuRowKey = `u:${member.id}`;

    const isBlocked = blocksStore.getState().blockedByMe.has(member.id);
    const voiceTarget = isSelf || !outranks ? undefined : serverVoiceTarget(member.id);
    const voiceMod =
      voiceTarget === undefined || opts.voiceModFor === undefined
        ? undefined
        : opts.voiceModFor(voiceTarget.channelId, voiceTarget.user);
    const { onTimeoutMember, onRemoveTimeout, onMessageUser, onCallUser, onChangeNickname } = opts;

    withMemberMenu(({ createMemberContextMenu }) => {
      if (seq !== menuOpenSeq || signal.aborted || !item.isConnected) {
        if (seq === menuOpenSeq) menuRowKey = null;
        return;
      }
      // Kept on screen and re-placed when it resizes, so the ban form expanding
      // cannot push Confirm Ban and Block off the bottom at the 940x500 minimum.
      const created = createMemberContextMenu({
        x: clientX,
        y: clientY,
        userId: member.id,
        username: member.username,
        currentRole: member.role,
        availableRoles,
        showAdminActions,
        canKick: gates.canKick,
        canBan: gates.canBan,
        // PATCH role_id replaces every role, so a multi-role server manages
        // roles from the profile popup's chips instead.
        canManageRoles: gates.canManageRoles && !multiRoleEnabled(),
        canTimeout: gates.canTimeout,
        canManageNicknames: gates.canManageNicknames,
        isSelf,
        isBlocked,
        timeoutState: timeoutStateOf(member.id),
        onProfile: () => openProfile(clientX, clientY),
        onMention: () => {
          mentionInComposer(member.username);
        },
        ...(canMention() ? {} : { mentionDisabledReason: shellText("member.mentionUnavailable") }),
        ...(onMessageUser === undefined ? {} : { onMessage: () => onMessageUser(member.id) }),
        ...(onCallUser === undefined ? {} : { onCall: () => onCallUser(member.id) }),
        ...(voiceMod === undefined ? {} : { voiceMod }),
        ...(onTimeoutMember === undefined
          ? {}
          : {
              onTimeout: (seconds: number) => onTimeoutMember(member.id, member.username, seconds),
            }),
        ...(onRemoveTimeout === undefined
          ? {}
          : { onRemoveTimeout: () => onRemoveTimeout(member.id, member.username) }),
        onToggleBlock: () => opts.onToggleBlock(member.id, memberDisplayName(member), !isBlocked),
        onKick: () => opts.onKick(member.id, member.username),
        onBan: () => opts.onBan(member.id, member.username, memberDisplayName(member)),
        onChangeRole: (newRole: string) => opts.onChangeRole(member.id, member.username, newRole),
        ...(onChangeNickname === undefined
          ? {}
          : {
              onChangeNickname: () =>
                onChangeNickname(member.id, member.username, member.displayName ?? null),
            }),
        restoreFocusTo: () => hooks.focusMember(member.id),
        onClosed: () => {
          if (activeMenu !== created) return;
          activeMenu = null;
          menuRowKey = null;
        },
      });
      activeMenu = created;
    });
  };
  item.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key opens the menu,
  // focused on its first item, and Escape restores focus to this row.
  openMenuOnKeyboard(item, openContextMenu, signal);

  return item;
}

/** Rows that fit in the scroller, at least one: the PageUp/PageDown stride. */
function pageSize(from: HTMLElement): number {
  let scroller = from.parentElement;
  while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement;
  }
  const rowHeight = from.offsetHeight;
  if (scroller === null || rowHeight <= 0) return 10;
  return Math.max(1, Math.floor(scroller.clientHeight / rowHeight));
}

/** The member list, plus a way for its owner to return focus to a member's row. */
export interface MemberListComponent extends MountableComponent {
  /** Focus member `id`'s row, or the first row when that member is gone. Returns the row. */
  focusMember(id: number): HTMLElement | null;
}

export function createMemberList(opts: MemberListOptions): MemberListComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let searchWrap: HTMLDivElement | null = null;
  // The filter lives here, so every store-driven render re-applies it. It is
  // not persisted: a remount starts with an empty box.
  let query = "";
  // Sorted and grouped members, updated in place of a rebuild on each store
  // change. Model only: it holds no DOM and is dropped with the component.
  let model: MemberModel | null = null;
  // What the list shows now, in order: navigation walks this, not DOM siblings.
  let items: readonly ListItem[] = [];
  // Rows are reused across renders, so each owns its listeners: a row's owner
  // is destroyed when reconcile removes or rebuilds it (listeners on
  // the component-lifetime signal would retain every discarded row), and
  // destroy() disposes the rest. Per-row state lives in WeakMaps keyed by the
  // row element.
  const ownerByEl = new WeakMap<Element, Disposable>();
  const idByEl = new WeakMap<Element, number>();

  // Virtual mode (more than VIRTUAL_ABOVE members): rows are absolutely
  // positioned inside `root`, whose height is the whole list, and only the
  // window around the viewport is in the DOM. Store changes and scrolls
  // schedule one frame; `items` and `offsets` always describe the whole list.
  let virtual = false;
  let frameId: number | null = null;
  let inFrame = false;
  let queryChanged = false;
  let flatModel: MemberModel | null = null;
  let flatQuery = "";
  let itemIndex = new Map<string, number>();
  let offsets = buildOffsets([]);
  let offsetsDirty = true;
  let revealKey: string | null = null;
  const heights = [...ESTIMATED_HEIGHTS];
  const kindByEl = new WeakMap<Element, number>();
  const topByKey = new Map<string, number>();
  const samples: (Element | null)[] = [null, null, null, null];
  const sampleSizes = new WeakMap<Element, string>();
  let scroller: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  let scrollBinding: Disposable | null = null;

  function rowEl(id: number): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`[data-testid="member-${id}"]`) ?? null;
  }

  function flushFrame(): void {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    runFrame();
  }

  /** Draw member `id`'s row now when the window left it out (virtual mode). */
  function reveal(id: number): void {
    if (!virtual || inFrame || rowEl(id) !== null) return;
    revealKey = `u:${id}`;
    flushFrame();
    revealKey = null;
  }

  /** The row to focus when the member is gone: in virtual mode the first drawn
   *  row inside the scroller's view, so focus never drags the list to a pinned
   *  or overscan row. */
  function fallbackRow(): HTMLElement | null {
    const first = root?.querySelector<HTMLElement>(".member-item") ?? null;
    if (!virtual || scroller === null || root === null) return first;
    const view = scroller.getBoundingClientRect();
    // The scroll padding is the strip under the sticky search box, which
    // scrollIntoView keeps clear, so a row there would still scroll.
    const css = getComputedStyle(scroller);
    const top = view.top + scroller.clientTop + (parseFloat(css.scrollPaddingTop) || 0);
    const bottom =
      view.top +
      scroller.clientTop +
      scroller.clientHeight -
      (parseFloat(css.scrollPaddingBottom) || 0);
    for (const row of root.querySelectorAll<HTMLElement>(".member-item")) {
      const box = row.getBoundingClientRect();
      if (box.top >= top && box.bottom <= bottom) return row;
    }
    return first;
  }

  function focusMember(id: number): HTMLElement | null {
    reveal(id);
    const el = rowEl(id) ?? fallbackRow();
    if (el === null) {
      // No rows left (a search nobody matches): the search box keeps focus in the list.
      const search = searchWrap?.querySelector<HTMLElement>(".member-search") ?? null;
      search?.focus();
      return search;
    }
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
    return el;
  }

  function navigate(key: string, id: number, from: HTMLElement): void {
    const rows = items.filter((item) => item.kind === "row");
    if (rows.length === 0) return;
    // Looked up by id at key time, so a member that moved group continues from
    // where it is now.
    const at = rows.findIndex((item) => item.member.id === id);
    const last = rows.length - 1;
    let next: number;
    switch (key) {
      case "ArrowDown":
        next = Math.min(last, at + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, at - 1);
        break;
      case "PageDown":
        next = Math.min(last, at + pageSize(from));
        break;
      case "PageUp":
        next = Math.max(0, at - pageSize(from));
        break;
      case "Home":
        next = 0;
        break;
      default:
        next = last;
    }
    const target = rows[next];
    if (target !== undefined && target.member.id !== id) focusMember(target.member.id);
  }

  const hooks: RowHooks = { navigate, focusMember };

  /** Put a row at its offset (virtual mode) or back in the flow (full mode). */
  function place(el: Element, key: string): void {
    const top = virtual ? topByKey.get(key) : undefined;
    if (top === undefined) {
      if (el.hasAttribute("style")) el.removeAttribute("style");
      return;
    }
    const style = (el as HTMLElement).style;
    const px = `${top}px`;
    if (style.top !== px) style.cssText = `position: absolute; left: 0; right: 0; top: ${px}`;
  }

  function reconcileRows(list: readonly ListItem[]): void {
    if (root === null) return;
    // A row that holds focus and is filtered away or removed drops focus to
    // the page; it goes to the same member if still shown, else the first row.
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && focused.parentElement === root
        ? idByEl.get(focused)
        : undefined;
    reconcileModels<ListItem, MemberItemModel>(root, list, {
      key: (item) => item.key,
      model: itemModel,
      // Status is a patch field: it changes the dot in place without a rebuild.
      // A row rebuilt while its context menu is open drops focus to the page
      // when the menu closes (accepted; only its own name, avatar, custom
      // status or role colour changing does this).
      patch: { fields: MEMBER_PATCH_FIELDS, apply: patchMemberItem },
      create: (drawn, atEvent) => {
        const el = drawMemberItem(drawn, createAvatarElement);
        if (drawn.kind === "row") {
          const owner = new Disposable();
          createMemberItem(el, atEvent, opts, hooks, owner.signal);
          ownerByEl.set(el, owner);
          idByEl.set(el, drawn.id);
        }
        kindByEl.set(el, kindOfModel(drawn));
        return el;
      },
      dispose: (el) => {
        ownerByEl.get(el)?.destroy();
        ownerByEl.delete(el);
        idByEl.delete(el);
      },
    });
    // The container holds exactly one child per item, in order.
    list.forEach((item, i) => {
      const el = root?.children[i];
      if (el !== undefined) place(el, item.key);
    });
    if (
      focusedId !== undefined &&
      !(
        document.activeElement instanceof HTMLElement &&
        document.activeElement.parentElement === root
      )
    ) {
      focusMember(focusedId);
    }
  }

  function renderFull(): void {
    const members = membersStore.getState().members;
    const roles = channelsStore.getState().roles;
    model = model === null ? buildModel(members, roles) : updateModel(model, members, roles);
    items = flattenModel(model, query);
    reconcileRows(items);
  }

  function render(): void {
    if (root === null) return;
    if (membersStore.getState().members.size > VIRTUAL_ABOVE) {
      virtual = true;
      schedule();
      return;
    }
    if (virtual) leaveVirtual();
    queryChanged = false;
    renderFull();
  }

  function leaveVirtual(): void {
    virtual = false;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    flatModel = null;
    topByKey.clear();
    root?.removeAttribute("style");
  }

  function schedule(): void {
    if (!virtual || frameId !== null || root === null) return;
    frameId = requestAnimationFrame(runFrame);
  }

  function findScroller(): HTMLElement | null {
    for (let el = root?.parentElement ?? null; el !== null; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") return el;
    }
    return null;
  }

  function bindScroller(next: HTMLElement | null): void {
    if (next === scroller) return;
    scrollBinding?.destroy();
    scrollBinding = null;
    if (scroller !== null) observer?.unobserve(scroller);
    scroller = next;
    if (next === null) return;
    if (root !== null) observer?.unobserve(root);
    const binding = new Disposable();
    scrollBinding = binding;
    next.addEventListener("scroll", schedule, { passive: true, signal: binding.signal });
    observer?.observe(next);
  }

  // A scroller or a sampled row that changed size (collapse and expand, drag
  // resize, a font-size change) needs a frame. A sample's first report is only
  // its starting size, so a new sample never schedules one.
  function onResize(entries: readonly ResizeObserverEntry[]): void {
    let changed = false;
    for (const { target, contentRect } of entries) {
      const size = `${contentRect.width}x${contentRect.height}`;
      const before = sampleSizes.get(target);
      sampleSizes.set(target, size);
      if (before !== size && (before !== undefined || target === scroller || target === root)) {
        changed = true;
      }
    }
    if (changed) schedule();
  }

  /** Re-measure each kind from the rows in the DOM; true when a height changed.
   *  The larger measurement within a kind wins, so a taller glyph fallback
   *  leaves a gap and never an overlap. */
  function measure(): boolean {
    if (root === null) return false;
    const seen = [0, 0, 0, 0];
    const margins = [0, 0, 0, 0];
    for (const child of root.children) {
      const kind = kindByEl.get(child);
      if (kind === undefined) continue;
      const height = child.getBoundingClientRect().height;
      if (!(height > 0)) continue;
      if (seen[kind] === 0) {
        const style = getComputedStyle(child);
        margins[kind] = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      }
      seen[kind] = Math.max(seen[kind]!, height);
    }
    let changed = false;
    for (let kind = 0; kind < heights.length; kind++) {
      if (seen[kind] === 0) continue;
      const total = seen[kind]! + margins[kind]!;
      if (Math.abs(total - heights[kind]!) < 0.01) continue;
      heights[kind] = total;
      changed = true;
    }
    if (changed) offsetsDirty = true;
    return changed;
  }

  function pinnedIndices(): number[] {
    const active = document.activeElement;
    const focusedId =
      active instanceof HTMLElement && active.parentElement === root
        ? idByEl.get(active)
        : undefined;
    const out: number[] = [];
    for (const key of [focusedId === undefined ? null : `u:${focusedId}`, menuRowKey, revealKey]) {
      const at = key === null ? undefined : itemIndex.get(key);
      if (at !== undefined) out.push(at);
    }
    return out;
  }

  /** Draw the window and the pinned rows. */
  function paint(): void {
    if (root === null) return;
    const wanted: ListItem[] = [];
    topByKey.clear();
    // Rows are positioned from the root's padding edge, so its own padding is
    // added back to keep the spacing the flowed list has.
    const css = getComputedStyle(root);
    const padTop = parseFloat(css.paddingTop) || 0;
    const padBottom = parseFloat(css.paddingBottom) || 0;
    const borderBox = css.boxSizing === "border-box";
    if (scroller !== null) {
      const viewTop =
        scroller.getBoundingClientRect().top +
        scroller.clientTop -
        root.getBoundingClientRect().top;
      const range = rangeFor(
        offsets,
        viewTop - padTop,
        scroller.clientHeight,
        OVERSCAN,
        pinnedIndices(),
      );
      const draw = (at: number): void => {
        const item = items[at]!;
        topByKey.set(item.key, padTop + offsets[at]!);
        wanted.push(item);
      };
      for (const at of range.pinned) if (at < range.start) draw(at);
      for (let at = range.start; at < range.end; at++) draw(at);
      for (const at of range.pinned) if (at >= range.end) draw(at);
    }
    reconcileRows(wanted);
    const total = offsets[offsets.length - 1]! + (borderBox ? padTop + padBottom : 0);
    root.style.position = "relative";
    root.style.height = `${total}px`;
  }

  function runFrame(): void {
    frameId = null;
    if (root === null || !virtual || inFrame) return;
    inFrame = true;
    try {
      if (observer === null && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(onResize);
        disposable.addCleanup(() => observer?.disconnect());
      }
      // Until a scroller is found (the panel is built before its host appends
      // it) the root itself is watched, so connecting it schedules a frame.
      if (scroller === null || !scroller.contains(root)) {
        bindScroller(findScroller());
        if (scroller === null) observer?.observe(root);
      }
      model = memberModelFor(membersStore.getState().members, channelsStore.getState().roles);
      if (model !== flatModel || query !== flatQuery) {
        flatModel = model;
        flatQuery = query;
        items = flattenModel(model, query);
        itemIndex = new Map(items.map((item, at) => [item.key, at]));
        offsetsDirty = true;
      }
      if (queryChanged) {
        queryChanged = false;
        if (scroller !== null && scroller.scrollTop > 0) scroller.scrollTop = 0;
      }
      measure();
      for (let pass = 0; pass < 2; pass++) {
        if (offsetsDirty) {
          offsets = buildOffsets(items.map((item) => heights[kindOf(item)]!));
          offsetsDirty = false;
        }
        paint();
        // Re-measure what was just drawn: a new row of a kind can be taller
        // than the one measured before (a wrapped role name, a font change
        // while no row of that kind was drawn).
        if (!measure()) break;
      }
      sampleRows();
    } finally {
      inFrame = false;
    }
  }

  /** Watch one row of each kind, so a height change that moves nothing else
   *  still reaches `onResize`. */
  function sampleRows(): void {
    if (root === null) return;
    const first: (Element | null)[] = [null, null, null, null];
    for (const child of root.children) {
      const kind = kindByEl.get(child);
      if (kind !== undefined && first[kind] === null) first[kind] = child;
    }
    first.forEach((el, kind) => {
      const old = samples[kind];
      if (el === old) return;
      if (old !== null && old !== undefined) observer?.unobserve(old);
      if (el !== null) observer?.observe(el);
      samples[kind] = el;
    });
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "member-list", "data-testid": "member-list" });
    const label = shellText("members.search");
    const search = createElement("input", {
      type: "search",
      class: "dm-search member-search",
      "data-testid": "member-search",
      maxlength: "100",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: label,
      "aria-label": label,
    });
    search.addEventListener(
      "input",
      () => {
        query = search.value;
        queryChanged = true;
        render();
      },
      { signal: disposable.signal },
    );
    search.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || isImeCommit(e) || search.value === "") return;
        e.preventDefault();
        e.stopPropagation();
        search.value = "";
        query = "";
        queryChanged = true;
        render();
      },
      { signal: disposable.signal },
    );
    searchWrap = createElement("div", { class: "member-search-wrap" });
    searchWrap.appendChild(search);
    render();

    // Members and the server's role list (role management makes it mutable at
    // runtime: a roles_update broadcast replaces it) both decide the groups.
    select(
      [membersStore, channelsStore],
      (m, c) => ({ members: m.members, roles: c.roles }),
      () => {
        render();
      },
      // Each slice keeps its own shallow compare, so a copied Map with the
      // same entries does not re-render.
      {
        signal: disposable.signal,
        equals: (a, b) => shallowEqual(a.members, b.members) && shallowEqual(a.roles, b.roles),
      },
    );

    disposable.addCleanup(() => scrollBinding?.destroy());
    container.append(searchWrap, root);
  }

  function destroy(): void {
    closeActiveMenu();
    for (const close of ownPopupClosers) close();
    ownPopupClosers.clear();
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    disposable.destroy();
    if (root !== null) {
      for (const child of Array.from(root.children)) ownerByEl.get(child)?.destroy();
      root.remove();
      root = null;
    }
    searchWrap?.remove();
    searchWrap = null;
  }

  return { mount, destroy, focusMember };
}
