/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (force logout, ban, role change).
 */

import { createElement, appendChildren, setText, setOwnedTimeout } from "@lib/dom";
import { reconcileChildren } from "@lib/reconcile";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import {
  membersStore,
  memberDisplayName,
  type Member,
  type MembersState,
} from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore, type ChannelsState } from "@stores/channels.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";
import { withMemberMenu } from "./member-menu-loader";
import { assignableRoleNames, outranksPosition } from "../features/moderation/roleAssignment";
import { memberTimeoutsStore } from "../features/moderation/store";
import { canMention, mentionInComposer } from "../features/messaging/activeComposer";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
import { openMenuOnKeyboard } from "@lib/context-menu";
import { Permission, type ReadyRole, type UserStatus } from "@lib/types";
import { positionForRole, roleHasPermission } from "@lib/permissions";
import { createAvatarElement, pickAvatarColor } from "./message-list/avatar";
import { readableRoleColor } from "@lib/themes";
import { shellText, statusLabel } from "../i18n/shell";
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
  readonly onToggleBlock: (userId: number, username: string, block: boolean) => Promise<void>;
  /** Block / Unblock from the profile popup, which confirms a Block in a
   *  dialog (the row menu confirms inline). Omitted: the popup has no button. */
  readonly onBlockFromPopup?: (userId: number, username: string, block: boolean) => void;
  /** Start a DM with a user (wires the profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
  /** Call a user: open (or create) the 1:1 DM with them and start a call in
   *  it (wires the profile popup's Call button, BUG-05). */
  readonly onCallUser?: (userId: number) => void;
  /** Report a user to this server's moderators (the profile popup's Report button, B9-10). */
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
}

/**
 * Menu items the signed-in user's role permits, from the permission mask the
 * server ships in `ready`. Administrator implies all three. When the role name
 * has no match in that list (pre-`ready`, or an older server that sent none)
 * the legacy owner/admin name check stands in — a mask of 0 would otherwise
 * hide moderation from every actual admin.
 */
function moderationGates(roleName: string): ModerationGates {
  return {
    canKick: roleHasPermission(roleName, Permission.KICK_MEMBERS),
    canBan: roleHasPermission(roleName, Permission.BAN_MEMBERS),
    canManageRoles: roleHasPermission(roleName, Permission.MANAGE_ROLES),
    canTimeout: roleHasPermission(roleName, Permission.MODERATE_MEMBERS),
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

function statusColor(status: UserStatus): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow)";
    case "dnd":
      return "var(--red)";
    case "invisible":
    case "offline":
      return "var(--text-micro)";
    default:
      return "var(--text-micro)";
  }
}

let activeMenu: { element: HTMLDivElement; destroy(): void } | null = null;

/** Bumped by every open, close and list teardown. The menu module loads lazily
 *  on the first right-click; a load that finishes after a newer open or a
 *  destroy sees a changed value and renders nothing. */
let menuOpenSeq = 0;

function closeActiveMenu(): void {
  menuOpenSeq += 1;
  if (activeMenu !== null) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

// One outside-click owner per open menu: destroyed when the menu closes and
// when the list is torn down.
let menuDismiss: Disposable | null = null;

function releaseMenuDismiss(): void {
  menuDismiss?.destroy();
  menuDismiss = null;
}

function handleOutsideClick(e: MouseEvent): void {
  if (activeMenu !== null && !activeMenu.element.contains(e.target as Node)) {
    closeActiveMenu();
    releaseMenuDismiss();
  }
}

/**
 * Closers for the profile popups this list opened. destroy() runs only these:
 * each is a no-op once another opener replaced its popup, so a card MessageList
 * opened stays up when the sidebar switches away from the member list.
 */
const ownPopupClosers = new Set<() => void>();

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

/** What a row reads at event time: the live member, and the status its dot shows. */
interface MemberRowRef {
  member: Member;
  shownStatus: UserStatus;
}

function createMemberItem(
  ref: MemberRowRef,
  colorVar: string,
  opts: MemberListOptions,
  hooks: RowHooks,
  signal: AbortSignal,
): HTMLDivElement {
  const shown = ref.member;
  const item = createElement("div", {
    class: isAwayStatus(shown.status) ? "member-item offline" : "member-item",
    "data-testid": `member-${shown.id}`,
    role: "button",
    tabindex: "0",
    "aria-haspopup": "dialog",
    "aria-label": memberDisplayName(shown),
  });
  const statusId = `mi-status-${shown.id}`;
  const customId = `mi-custom-status-${shown.id}`;

  const avatar = createAvatarElement(
    { username: shown.username, displayName: shown.displayName, avatar: shown.avatar },
    {
      className: "mi-avatar",
      background: pickAvatarColor(shown.username),
      deferUntilVisible: true,
    },
  );

  const statusDot = createElement("div", {
    class: "mi-status",
    id: statusId,
    style: `background: ${statusColor(shown.status)}`,
    "aria-label": statusLabel(shown.status),
    title: statusLabel(shown.status),
  });
  avatar.appendChild(statusDot);

  // Name + custom status stack. The custom status is only rendered when there
  // is one, so a member without it keeps the single-line row it always had.
  const nameWrap = createElement("div", { class: "mi-text" });
  const name = createElement("span", {
    class: "mi-name",
    style: `color: ${readableRoleColor(colorVar)}`,
    "data-role-color": colorVar,
  });
  setText(name, memberDisplayName(shown));
  nameWrap.appendChild(name);
  const custom = shown.customStatus;
  if (typeof custom === "string" && custom.length > 0) {
    const customEl = createElement("span", {
      class: "mi-custom-status",
      "data-testid": `member-custom-status-${shown.id}`,
      id: customId,
    });
    setText(customEl, custom);
    nameWrap.appendChild(customEl);
    item.setAttribute("aria-describedby", `${customId} ${statusId}`);
  } else {
    item.setAttribute("aria-describedby", statusId);
  }

  appendChildren(item, avatar, nameWrap);

  // Left-click, Enter or Space opens the profile popup (previously dead code —
  // built and tested but never mounted from anywhere). The row is a button so
  // the profile, and its Report action, is reachable from the keyboard.
  const openProfile = (anchorX: number, anchorY: number): void => {
    closeActiveMenu();
    // The row is reused across store updates, so the member is read from the
    // ref at event time, never from the render-time snapshot.
    const member = ref.member;
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
      hooks.navigate(e.key, ref.member.id, item);
    },
    { signal },
  );

  // Context menu for admin actions. `openContextMenu` takes viewport
  // coordinates; the keyboard path (Shift+F10 / the Menu key) anchors to the
  // row's own edge instead of a pointer position.
  const openContextMenu = (clientX: number, clientY: number): void => {
    const member = ref.member;
    const isSelf = member.id === (authStore.getState().user?.id ?? 0);

    // Moderation actions are permission-gated per item (a role name told us
    // nothing about what its bits allow); block/unblock is open to everyone.
    // The role name is read live from authStore, not the opts snapshot
    // taken once at mount -- dispatcher.ts keeps authStore.user.role
    // current on every self MEMBER_UPDATE precisely so gates like this one
    // see a promotion/demotion without waiting for the sidebar to rebuild.
    const actorRole = authStore.getState().user?.role ?? opts.currentUserRole;
    const baseGates = moderationGates(actorRole);
    // The server refuses moderation of a member ranked at or above the actor
    // and any role assignment at or above the actor's own rank; mirror both so
    // the menu never offers a request that cannot succeed. Unknown positions
    // (an older server) leave the decision to the server.
    const actorPosition = positionForRole(actorRole);
    const targetPosition = positionForRole(member.role);
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
    };
    const showAdminActions =
      !isSelf && (gates.canKick || gates.canBan || gates.canManageRoles || gates.canTimeout);

    closeActiveMenu();
    releaseMenuDismiss();
    const seq = menuOpenSeq;

    const isBlocked = blocksStore.getState().blockedByMe.has(member.id);
    const voiceTarget = isSelf || !outranks ? undefined : serverVoiceTarget(member.id);
    const voiceMod =
      voiceTarget === undefined || opts.voiceModFor === undefined
        ? undefined
        : opts.voiceModFor(voiceTarget.channelId, voiceTarget.user);
    const { onTimeoutMember, onRemoveTimeout, onMessageUser, onCallUser } = opts;

    withMemberMenu(({ createMemberContextMenu }) => {
      if (seq !== menuOpenSeq || signal.aborted || !item.isConnected) return;
      const created = createMemberContextMenu({
        userId: member.id,
        username: member.username,
        currentRole: member.role,
        availableRoles,
        showAdminActions,
        canKick: gates.canKick,
        canBan: gates.canBan,
        canManageRoles: gates.canManageRoles,
        canTimeout: gates.canTimeout,
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
        restoreFocusTo: () => hooks.focusMember(member.id),
        onClosed: () => {
          if (activeMenu !== created) return;
          activeMenu = null;
          releaseMenuDismiss();
        },
      });
      activeMenu = created;
      placeMenu(created.element, clientX, clientY);
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

/** Mount the menu at the anchor and arrange its dismissal. */
function placeMenu(menuEl: HTMLDivElement, clientX: number, clientY: number): void {
  // Position at the anchor, kept on screen: a member low in the list at the
  // 940x500 minimum window opened the menu past the bottom edge, leaving
  // Force Logout, Ban and Block unreachable. When it does not fit below
  // the anchor it is anchored by its bottom edge instead. The placement
  // is re-run whenever the menu resizes, so the ban form expanding later
  // cannot push Confirm Ban and Block off-screen from either anchor.
  menuEl.style.position = "fixed";
  menuEl.style.zIndex = "1000";
  document.body.appendChild(menuEl);
  const margin = 8;
  const place = (): void => {
    const { innerWidth: vw, innerHeight: vh } = window;
    const height = menuEl.offsetHeight;
    const left = Math.min(clientX, vw - menuEl.offsetWidth - margin);
    menuEl.style.left = `${Math.max(margin, left)}px`;
    if (clientY + height > vh - margin) {
      const bottom = Math.min(vh - clientY, vh - height - margin);
      menuEl.style.top = "";
      menuEl.style.bottom = `${Math.max(margin, bottom)}px`;
    } else {
      menuEl.style.bottom = "";
      menuEl.style.top = `${clientY}px`;
    }
  };
  place();

  // Close on outside click (deferred so this click doesn't close it)
  const dismiss = new Disposable();
  menuDismiss = dismiss;
  const resizeObserver = new ResizeObserver(place);
  resizeObserver.observe(menuEl);
  dismiss.addCleanup(() => resizeObserver.disconnect());
  setOwnedTimeout(
    dismiss.signal,
    () => {
      document.addEventListener("mousedown", handleOutsideClick, { signal: dismiss.signal });
    },
    0,
  );
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
  // is destroyed when reconcile removes or rebuilds it (OC-0295 - listeners on
  // the component-lifetime signal would retain every discarded row), and
  // destroy() disposes the rest. Per-row state lives in WeakMaps keyed by the
  // row element.
  const ownerByEl = new WeakMap<Element, Disposable>();
  const refByEl = new WeakMap<Element, MemberRowRef>();

  function patchStatus(el: Element, ref: MemberRowRef): void {
    const { status } = ref.member;
    if (status === ref.shownStatus) return;
    ref.shownStatus = status;
    el.classList.toggle("offline", isAwayStatus(status));
    const dot = el.querySelector<HTMLDivElement>(".mi-status");
    if (dot !== null) {
      dot.style.background = statusColor(status);
      dot.setAttribute("aria-label", statusLabel(status));
      dot.title = statusLabel(status);
    }
  }

  function rowEl(id: number): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`[data-testid="member-${id}"]`) ?? null;
  }

  function focusMember(id: number): HTMLElement | null {
    const el = rowEl(id) ?? root?.querySelector<HTMLElement>(".member-item") ?? null;
    if (el === null) return null;
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

  function render(): void {
    if (root === null) return;
    const members = membersStore.getState().members;
    const roles = channelsStore.getState().roles;
    model = model === null ? buildModel(members, roles) : updateModel(model, members, roles);
    items = flattenModel(model, query);
    // A row that holds focus and is filtered away or removed drops focus to
    // the page; it goes to the same member if still shown, else the first row.
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && focused.parentElement === root
        ? refByEl.get(focused)?.member.id
        : undefined;
    reconcileChildren<ListItem>(root, items, {
      key: (item) => item.key,
      // A header's text is patched in `update`, not part of its signature.
      // Status is not here: it patches the dot in place without a rebuild.
      // A row rebuilt while its context menu is open drops focus to the page
      // when the menu closes (accepted; only its own name, avatar, custom
      // status or role colour changing does this).
      signature: (item) =>
        item.kind === "row"
          ? [
              item.member.username,
              item.member.displayName ?? "",
              item.member.avatar ?? "",
              item.member.customStatus ?? "",
              item.colorVar,
            ].join("\u0001")
          : item.kind === "empty"
            ? item.text
            : "",
      create: (item) => {
        if (item.kind === "header") {
          return createElement(
            "div",
            {
              class: "member-role-group",
              ...(item.offline ? { "data-testid": "member-group-offline" } : {}),
            },
            item.text,
          );
        }
        if (item.kind === "empty") {
          const emptyState = createElement("div", { class: "member-list-empty" });
          emptyState.appendChild(
            createElement("p", { class: "member-list-empty-text" }, item.text),
          );
          return emptyState;
        }
        const owner = new Disposable();
        const ref: MemberRowRef = { member: item.member, shownStatus: item.member.status };
        const row = createMemberItem(ref, item.colorVar, opts, hooks, owner.signal);
        ownerByEl.set(row, owner);
        refByEl.set(row, ref);
        return row;
      },
      update: (el, item) => {
        // A header keeps its node when only its count changes.
        if (item.kind === "header") {
          if (el.textContent !== item.text) setText(el, item.text);
          return;
        }
        if (item.kind !== "row") return;
        const ref = refByEl.get(el);
        if (ref === undefined) return;
        ref.member = item.member;
        patchStatus(el, ref);
      },
      dispose: (el) => {
        ownerByEl.get(el)?.destroy();
        ownerByEl.delete(el);
        refByEl.delete(el);
      },
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
        render();
      },
      { signal: disposable.signal },
    );
    search.addEventListener(
      "keydown",
      (e) => {
        if (e.isComposing || e.key !== "Escape" || search.value === "") return;
        e.preventDefault();
        e.stopPropagation();
        search.value = "";
        query = "";
        render();
      },
      { signal: disposable.signal },
    );
    searchWrap = createElement("div", { class: "member-search-wrap" });
    searchWrap.appendChild(search);
    render();

    disposable.onStoreChange<MembersState, ReadonlyMap<number, Member>>(
      membersStore,
      (s) => s.members,
      () => {
        render();
      },
    );

    // Role groups, their labels and their colors all come from the server's
    // role list, which role management makes mutable at runtime (a roles_update
    // broadcast replaces it).
    disposable.onStoreChange<ChannelsState, readonly ReadyRole[]>(
      channelsStore,
      (s) => s.roles,
      () => {
        render();
      },
    );

    container.append(searchWrap, root);
  }

  function destroy(): void {
    closeActiveMenu();
    for (const close of ownPopupClosers) close();
    ownPopupClosers.clear();
    releaseMenuDismiss();
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
