/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users; a click joins, or opens the call once joined.
 * The voice rows draw from row models (features/channels/voiceRow*.ts) that
 * one `select` over their stores keeps current (5.4c-2); the text rows and the
 * category groups draw from models too (features/channels/channelRow*.ts, 5.4d).
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { reconcileModels, sameModel } from "@lib/reconcile";
import { select, eventSource, type Selection } from "@lib/select";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import type { MountableComponent } from "@lib/safe-render";
import { channelsStore } from "@stores/channels.store";
import { navigateToChannel } from "@lib/channel-navigation";
import { isChannelMuted } from "@lib/channel-mutes";
import { HIDE_MUTED_CHANNELS_KEY, isHideMutedChannels } from "@lib/hide-muted-channels";
import type { Channel, ChannelsState } from "@stores/channels.store";
import { authStore, getCurrentUser, type AuthState } from "@stores/auth.store";
import { uiStore, toggleCategory, type UiState } from "@stores/ui.store";
import { safetyStore, type SafetyState } from "../features/safety/store";
import { voiceStore } from "@stores/voice.store";
import type { PeerVerification, VoiceState, VoiceUser } from "@stores/voice.store";
import { SCREENSHARE_TILE_ID_OFFSET, USER_LOCAL_MUTE_CHANGED } from "@lib/constants";
import { openMenuOnKeyboard } from "@lib/context-menu";
import { createLazyScreen } from "./lazyScreen";
import { getUserLocalMute, getUserVolume } from "@lib/livekitSession";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";
import { attachCategoryContextMenu } from "./channel-sidebar/category-menu";
import { attachChannelContextMenu, CHANNEL_MUTE_CHANGED } from "./channel-sidebar/context-menu";
import { attachDragHandlers } from "./channel-sidebar/drag-reorder";
import { attachVoiceUserDrag, markVoiceDropTarget } from "../features/voice/dragMove";
import { openIdentityMismatchModal } from "../features/voice/peerVerification";
import { createAvatarElement, pickAvatarColor } from "@components/message-list/avatar";
import { membersStore, type Member, type MembersState } from "@stores/members.store";
import { roleHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";
import { joinRetryInMs } from "../features/voice/joinBackoff";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
import {
  drawCategoryGroup,
  drawTextChannelRow,
  type CategoryGroupModel,
} from "../features/channels/channelRow.view";
import {
  categoryGroupModel,
  channelAccess,
  channelGroups,
  channelRowModel,
  visibleRows,
  type ChannelGroup,
  type ChannelListContext,
  type ChannelListInputs,
  type ChannelRowModel,
} from "../features/channels/channelRowModel";
import {
  drawVoiceChannelChrome,
  drawVoiceUserRow,
  patchVoiceChannelChrome,
  patchVoiceUserRow,
  VOICE_USER_PATCH_FIELDS,
  type VoiceChannelChromeModel,
  type VoiceUserRowModel,
} from "../features/channels/voiceRow.view";
import {
  channelVoiceUsers,
  voiceChannelChrome,
  voiceUserModel,
  type VoiceRowInputs,
  type VoiceUserContext,
} from "../features/channels/voiceRowModel";

// The per-user volume menu loads on its first open (O-6b).
const volumeMenuScreen = createLazyScreen(
  "user-volume-menu",
  () => import("./channel-sidebar/volume-menu"),
);
/** Latest open request per sidebar (keyed by its lifetime signal); an earlier one still loading is dropped. */
const volumeMenuAttempts = new WeakMap<AbortSignal, number>();

export interface ChannelReorderData {
  readonly channelId: number;
  readonly newPosition: number;
  /** Position before the optimistic move, so a failed save can roll back. */
  readonly previousPosition: number;
}

/** Moderator actions on another user's voice session. Supplied by the page,
 *  which owns the WS socket; the sidebar only decides whether to offer them. */
export interface VoiceModerationCallbacks {
  readonly onServerMute: (channelId: number, userId: number, muted: boolean) => void;
  readonly onServerDeafen: (channelId: number, userId: number, deafened: boolean) => void;
  readonly onMove: (userId: number, toChannelId: number) => void;
  readonly onDisconnect: (userId: number) => void;
}

/** Whether the signed-in user's role holds MUTE_MEMBERS. Channel overrides can
 *  take that away or keep it, so the voice menu follows each channel's
 *  server-computed can_moderate_voice instead; this role-level answer only
 *  decides whether a channel with no verdict says why moderation is missing.
 *  Derived through the same helper as the member-list moderation gates. */
export function canModerateVoice(): boolean {
  const role = getCurrentUser()?.role ?? "";
  return roleHasPermission(role, Permission.MUTE_MEMBERS);
}

export interface ChannelSidebarOptions {
  readonly onVoiceJoin: (channelId: number) => void;
  /** Called when the user clicks the voice channel they are already in. Leaving
   *  is the voice widget's Disconnect, never a channel click. */
  readonly onOpenCall: () => void;
  /** Voice moderation wiring; the moderation menu section is hidden without it. */
  readonly onVoiceModerate?: VoiceModerationCallbacks;
  /** Called when the user clicks the "+" on a category header. */
  readonly onCreateChannel?: (category: string) => void;
  /** Called when the user right-clicks a channel and selects Edit. */
  readonly onEditChannel?: (channel: Channel) => void;
  /** Called when the user right-clicks a channel and selects Delete. */
  readonly onDeleteChannel?: (channel: Channel) => void;
  /** Called when the user drags a channel to a new position. */
  readonly onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void;
  /** Bulk-delete the newest `count` messages; gated on MANAGE_MESSAGES. */
  readonly onPurgeChannel?: (channel: Channel, count: number) => Promise<void>;
  /** Called when the user picks Invite People from a channel's menu. */
  readonly onInviteFromChannel?: (channel: Channel) => void;
  /** Called when the user clicks a voice user row to watch their stream. */
  readonly onWatchStream?: (userId: number) => void;
}

/** Moderation section for one participant row, from the channel's
 *  server-computed can_moderate_voice (B9-14, Q5): undefined when it is false
 *  (which hides the section entirely), and the reason it is unavailable when
 *  the server gave no verdict to a role that holds MUTE_MEMBERS. Read when the
 *  menu opens, so a role or override change since the last render counts. Move
 *  targets are the other voice channels; the server re-checks rank, timeouts
 *  and that the TARGET may connect to the one picked. */
export function buildVoiceModOptions(
  channelId: number,
  user: VoiceUser,
  cb?: VoiceModerationCallbacks,
): VoiceModMenuOptions | string | undefined {
  if (cb === undefined) return undefined;
  const verdict = channelsStore.getState().channels.get(channelId)?.canModerateVoice;
  if (verdict === undefined) {
    return canModerateVoice() ? voiceText("volume.modUnknown") : undefined;
  }
  if (!verdict) return undefined;
  const moveTargets = Array.from(channelsStore.getState().channels.values())
    .filter((ch) => ch.type === "voice" && ch.id !== channelId)
    .map((ch) => ({ id: ch.id, name: ch.name }));
  // Greyed with a reason rather than hidden while the socket is down: the
  // actions are server commands, and a click would be dropped silently.
  const connectionStatus = uiStore.getState().connectionStatus;
  const disabledReason =
    connectionStatus === "connected"
      ? undefined
      : voiceText(
          connectionStatus === "reconnecting" ? "volume.modReconnecting" : "volume.modNotConnected",
        );
  return {
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    serverMuted: user.serverMuted === true,
    serverDeafened: user.serverDeafened === true,
    moveTargets,
    onServerMute: (muted) => cb.onServerMute(channelId, user.userId, muted),
    onServerDeafen: (deafened) => cb.onServerDeafen(channelId, user.userId, deafened),
    onMove: (toChannelId) => cb.onMove(user.userId, toChannelId),
    onDisconnect: () => cb.onDisconnect(user.userId),
  };
}

/** A peer verification map for a voice state that has none yet: one shared
 *  instance, so an absent map compares equal across projections. */
const NO_VERIFICATIONS: ReadonlyMap<number, PeerVerification> = new Map();

/**
 * The voice rows' inputs from the states the sidebar's `select` hands it
 * (5.4c-2). Reads only its arguments; the optional voice fields an older
 * state lacks are defaulted here, as the row builders expect.
 */
function projectVoiceInputs(
  voice: VoiceState,
  members: MembersState,
  auth: AuthState,
  channels: ChannelsState,
  ui: UiState,
  safety: SafetyState,
  localMute: object,
): VoiceRowInputs {
  const voiceMembers = new Map<number, Member>();
  for (const users of voice.voiceUsers.values()) {
    for (const uid of users.keys()) {
      const member = members.members.get(uid);
      if (member !== undefined) voiceMembers.set(uid, member);
    }
  }
  const moderatable: number[] = [];
  for (const ch of channels.channels.values()) {
    if (ch.type === "voice" && ch.canModerateVoice === true) moderatable.push(ch.id);
  }
  return {
    voiceUsers: voice.voiceUsers,
    currentChannelId: voice.currentChannelId,
    peerVerifications: voice.peerVerifications ?? NO_VERIFICATIONS,
    localSessionFingerprint: voice.localSessionFingerprint ?? null,
    voiceMembers,
    selfId: auth.user?.id ?? null,
    connectionStatus: ui.connectionStatus,
    timeout: safety.timeout,
    moderatable: moderatable.toSorted((a, b) => a - b),
    localMute,
  };
}

/** `===` per field, except the two the projection builds fresh: the members
 *  in voice (equal when every entry is the same object, so presence churn of
 *  anyone else never reaches the voice rows) and the moderatable ids. */
function sameVoiceInputs(a: VoiceRowInputs, b: VoiceRowInputs): boolean {
  if (
    a.voiceUsers !== b.voiceUsers ||
    a.currentChannelId !== b.currentChannelId ||
    a.peerVerifications !== b.peerVerifications ||
    a.localSessionFingerprint !== b.localSessionFingerprint ||
    a.selfId !== b.selfId ||
    a.connectionStatus !== b.connectionStatus ||
    a.timeout !== b.timeout ||
    a.localMute !== b.localMute
  ) {
    return false;
  }
  if (a.voiceMembers.size !== b.voiceMembers.size) return false;
  for (const [uid, member] of a.voiceMembers) {
    if (b.voiceMembers.get(uid) !== member) return false;
  }
  return (
    a.moderatable.length === b.moderatable.length &&
    a.moderatable.every((id, i) => b.moderatable[i] === id)
  );
}

/** The voice channels with at least one participant, as one comparable key. */
function occupiedKey(inputs: VoiceRowInputs): string {
  const ids: number[] = [];
  for (const [channelId, users] of inputs.voiceUsers) {
    if (users.size > 0) ids.push(channelId);
  }
  return ids.toSorted((a, b) => a - b).join(",");
}

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const {
    onVoiceJoin,
    onOpenCall,
    onCreateChannel,
    onEditChannel,
    onDeleteChannel,
    onReorderChannel,
    onWatchStream,
    onVoiceModerate,
    onPurgeChannel,
    onInviteFromChannel,
  } = options;
  const disposable = new Disposable();
  // renderChannels() keys every row (B9-21): an unchanged row is reused and its
  // listeners left alone; a replaced row's listeners must be aborted before it
  // detaches. Per-row listeners (context menu, drag handlers) therefore hold
  // their own `Disposable` (ownerByEl), NOT the sidebar-lifetime
  // `disposable.signal` — addEventListener({ signal }) keeps a detached row
  // alive via that signal's own retained "abort" listener list until it fires,
  // so a row left on the sidebar signal would be retained for the sidebar's
  // whole lifetime (OC-0229). Header/root listeners registered once in mount()
  // still use `disposable.signal`.
  let root: HTMLDivElement | null = null;
  let channelList: HTMLDivElement | null = null;
  let serverNameEl: HTMLSpanElement | null = null;
  /** Closes the profile popup a voice user row opened; destroy() calls it. */
  let closeProfilePopup: (() => void) | null = null;

  /** Open a voice user's profile beside their row. The popup lives on
   *  document.body, so it takes the sidebar-lifetime signal: a voice re-render
   *  while it loads must not drop it. */
  function openProfile(userId: number, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    closeProfilePopup = openUserProfilePopup({
      userId,
      anchorX: rect.right,
      anchorY: rect.top,
      signal: disposable.signal,
      fallbackFocus: () => voiceRowByUserId.get(userId) ?? null,
    });
  }

  const unsubscribers: Array<() => void> = [];

  /** Each participant row now in the list, by user id: the profile popup's
   *  fallback focus. Set when a row is built; deleted when it is disposed,
   *  only if the map still holds that row (a user moved between channels is
   *  built in the new list before the old row goes). */
  const voiceRowByUserId = new Map<number, HTMLElement>();

  /** The voice row inputs (5.4c-2), from the one `select` mount() creates. */
  let voiceSel: Selection<VoiceRowInputs> | null = null;
  /** Each voice channel's live wrapper, for the refreshes that skip the full
   *  render. Set when the wrapper is built or updated; deleted when it is
   *  disposed, only if the entry is still that element. */
  const voiceWrappers = new Map<number, { el: Element; channel: Channel }>();
  /** The chrome model each voice wrapper was last drawn or patched to. */
  const chromeByEl = new WeakMap<Element, VoiceChannelChromeModel>();
  const voiceCtx: VoiceUserContext = {
    avatarColor: pickAvatarColor,
    // Muted for this client only (the volume menu's Mute, a tile mute, or an
    // older build's volume of 0); the select reruns on USER_LOCAL_MUTE_CHANGED.
    localSilenced: (userId) => getUserLocalMute(userId) || getUserVolume(userId) === 0,
    moderation: onVoiceModerate !== undefined,
  };

  /**
   * Listener owners for every keyed group and row. A reused element keeps its
   * owner; a replaced or removed one has its owner aborted before it detaches,
   * so a stale element can never outlive the render that replaced it (OC-0229)
   * — without aborting the listeners of every UNCHANGED row, which the old
   * single per-render controller did.
   */
  const ownerByEl = new WeakMap<Element, Disposable>();
  /** Each group's displayed rows, one array per group kept across renders and
   *  refilled in place, so Move Up/Down on a row built earlier swaps with the
   *  row shown next to it, not a channel a collapsed category hides. */
  const shownRowsByGroup = new Map<string, Channel[]>();

  /** Abort a group's or row's owner and those of the rows inside it,
   *  participant rows included, and forget the ones the sidebar indexes. */
  function disposeOwned(el: Element): void {
    for (const owned of [
      el,
      ...el.querySelectorAll(".category-channels-container > *, .voice-users-list > *"),
    ]) {
      ownerByEl.get(owned)?.destroy();
      const uid = (owned as HTMLElement).dataset?.voiceUid;
      if (uid !== undefined && voiceRowByUserId.get(Number(uid)) === owned) {
        voiceRowByUserId.delete(Number(uid));
      }
      for (const [channelId, entry] of voiceWrappers) {
        if (entry.el === owned) voiceWrappers.delete(channelId);
      }
    }
  }

  /** Bind one participant row's handlers. Live data (the user's username,
   *  streams and server mute, the joined channel) is read when an event fires,
   *  through `atEvent`, never kept from the render. */
  function createVoiceUserRow(
    model: VoiceUserRowModel,
    channelId: number,
    atEvent: () => VoiceUser,
  ): HTMLDivElement {
    const row = drawVoiceUserRow(model, createAvatarElement);
    const owner = new Disposable();
    ownerByEl.set(row, owner);
    const { signal } = owner;
    // Sidebar-lifetime signal for anything mounted outside this row: a menu
    // or modal on document.body must not be torn down by an unrelated
    // re-render (OC-0281, OC-0282). Row listeners stay on the row's own
    // signal, so they die with it (OC-0229).
    const lifetimeSignal = disposable.signal;
    voiceRowByUserId.set(model.userId, row);

    // A blocked peer's shield opens the re-trust prompt. The modal shows the
    // username, never the nickname: a nickname is user-settable.
    if (model.verify?.cls === "mismatch") {
      row.querySelector(":scope > .vu-verify.mismatch")?.addEventListener(
        "click",
        (e) => {
          e.stopPropagation();
          void openIdentityMismatchModal(
            model.userId,
            atEvent().username || shellText("common.unknown"),
            lifetimeSignal,
          );
        },
        { signal },
      );
    }

    // Right-click (or Shift+F10 / the Menu key, A11Y-01) for the per-user
    // volume and moderation menu; never on the local user's own row.
    if (!model.self) {
      const openVolumeMenu = (x: number, y: number): void => {
        // The options snapshot is taken now, at click time; the menu code
        // loads on its first open.
        const user = atEvent();
        const mod = buildVoiceModOptions(channelId, user, onVoiceModerate);
        const username = user.username || shellText("common.unknown");
        const attempt = (volumeMenuAttempts.get(lifetimeSignal) ?? 0) + 1;
        volumeMenuAttempts.set(lifetimeSignal, attempt);
        void volumeMenuScreen
          .load(() => !lifetimeSignal.aborted)
          .then((m) => {
            // A newer open supersedes this one (so a double open mounts one
            // menu), and a destroyed sidebar mounts nothing.
            if (
              m === null ||
              attempt !== volumeMenuAttempts.get(lifetimeSignal) ||
              lifetimeSignal.aborted
            )
              return;
            m.showUserVolumeMenu(user.userId, username, x, y, lifetimeSignal, mod);
            return;
          });
      };
      row.addEventListener(
        "contextmenu",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          openVolumeMenu(e.clientX, e.clientY);
        },
        { signal },
      );
      openMenuOnKeyboard(row, openVolumeMenu, signal);
      // Drag onto another voice channel to move them; the menu's "Move to" is
      // the keyboard path to the same command. Bound only where the model
      // draws the row as draggable, so the DOM is the model's draw.
      if (model.draggable && onVoiceModerate !== undefined) {
        attachVoiceUserDrag(
          row,
          channelId,
          model.userId,
          onVoiceModerate.onMove,
          signal,
          lifetimeSignal,
        );
      }
    }

    // A click watches their camera or stream; with nothing to watch it opens
    // their profile, as in the member list.
    row.addEventListener(
      "click",
      (e) => {
        // Don't trigger if the right-click menu is open
        if (e.button !== 0) return;
        e.stopPropagation();
        const user = atEvent();
        if (onWatchStream === undefined || (!user.camera && !user.screenshare)) {
          openProfile(user.userId, row);
          return;
        }
        // Watching a stream needs a live LiveKit room -- join first.
        if (voiceStore.getState().currentChannelId !== channelId) {
          // Read before the join: it refuses inside the wait, and an accepted switch arms one.
          const refused = joinRetryInMs() > 0;
          onVoiceJoin(channelId);
          if (refused) return;
        }
        if (voiceStore.getState().currentChannelId !== channelId) return;
        const tileId = user.screenshare ? user.userId + SCREENSHARE_TILE_ID_OFFSET : user.userId;
        onWatchStream(tileId);
      },
      { signal },
    );
    row.addEventListener(
      "keydown",
      (e) => {
        if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        row.click();
      },
      { signal },
    );
    return row;
  }

  /**
   * Bring a voice wrapper to the current inputs: patch its chrome when the
   * chrome model changed, then reconcile its participant rows by user id
   * (speaking patches in place; any other drawn change rebuilds that row).
   * `.voice-users-list` exists only while the channel has people in it.
   */
  function updateVoiceRow(el: Element, ch: Channel): void {
    if (voiceSel === null) return;
    const inputs = voiceSel.get();
    const chrome = voiceChannelChrome(ch, inputs);
    const prev = chromeByEl.get(el);
    if (prev !== undefined && !sameModel(prev, chrome)) patchVoiceChannelChrome(el, chrome);
    chromeByEl.set(el, chrome);
    voiceWrappers.set(ch.id, { el, channel: ch });

    const users = channelVoiceUsers(inputs, ch.id);
    let list = el.querySelector<HTMLElement>(":scope > .voice-users-list");
    if (users.length === 0 && list === null) return;
    if (list === null) {
      list = createElement("div", { class: "voice-users-list" });
      el.appendChild(list);
    }
    reconcileModels<VoiceUser, VoiceUserRowModel>(list, users, {
      key: (u) => String(u.userId),
      model: (u) => voiceUserModel(u, ch.id, inputs, voiceCtx),
      patch: { fields: VOICE_USER_PATCH_FIELDS, apply: patchVoiceUserRow },
      create: (model, atEvent) => createVoiceUserRow(model, ch.id, atEvent),
      dispose: disposeOwned,
    });
    if (users.length === 0) list.remove();
  }

  /** A voice channel's wrapper: the chrome, the drop target, the channel
   *  click, then its participant rows, built now so the outer reconcile can
   *  restore focus into them by key. */
  function createVoiceRow(channel: Channel, signal: AbortSignal): HTMLDivElement {
    // voiceSel exists from mount() on, before the first render.
    const inputs = voiceSel?.get();
    // i18n-exempt: developer-facing invariant error, never shown to a user
    if (inputs === undefined) throw new Error("voice row built before the sidebar mounted");
    const wrapper = drawVoiceChannelChrome(voiceChannelChrome(channel, inputs));
    if (onVoiceModerate !== undefined) markVoiceDropTarget(wrapper, channel.id);
    wrapper.querySelector(":scope > .channel-item")?.addEventListener(
      "click",
      () => {
        // Frozen while the WS socket is down or timed out: a no-op, the reason
        // is the row's title. Everything is read now, at click time: the
        // wrapper is reused across joins and leaves.
        const joined = voiceStore.getState().currentChannelId === channel.id;
        if (uiStore.getState().connectionStatus !== "connected") return;
        if (!joined && safetyStore.getState().timeout !== null) return;
        if (joined) {
          // A repeat click while this join is still in progress (a double-click,
          // or retrying a slow "securing") must not cancel it: toggling here
          // cycled voice_join/voice_leave several times a second. The voice
          // widget's Disconnect still ends a join in progress.
          const status = voiceStore.getState().voiceStatus;
          if (status === "joining" || status === "securing") return;
          onOpenCall();
        } else {
          onVoiceJoin(channel.id);
        }
      },
      { signal },
    );
    updateVoiceRow(wrapper, channel);
    return wrapper;
  }

  /** Where focus sits on a participant row, if it does: its channel, user and
   *  position in that channel's list. */
  interface VoiceFocus {
    readonly channelId: number;
    readonly userId: number;
    readonly index: number;
  }

  function captureVoiceFocus(): VoiceFocus | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || channelList === null) return null;
    if (!channelList.contains(active)) return null;
    const row = active.closest<HTMLElement>(".voice-users-list > .voice-user-item");
    const list = row?.parentElement ?? null;
    const item = list?.parentElement?.querySelector<HTMLElement>(":scope > .channel-item") ?? null;
    if (row === null || list === null || item === null) return null;
    return {
      channelId: Number(item.dataset.channelId),
      userId: Number(row.dataset.voiceUid),
      index: Array.from(list.children).indexOf(row),
    };
  }

  /**
   * A focused participant who left or was moved hands focus to the
   * participant now at their position, else to the channel's own row, never
   * to the page. A kept or rebuilt row keeps focus by itself (the reconciler
   * follows its key), and a wrapper that is gone is `reconcileRows`' case.
   */
  function restoreVoiceFocus(was: VoiceFocus | null): void {
    if (was === null || channelList === null) return;
    const entry = voiceWrappers.get(was.channelId);
    if (entry === undefined || !channelList.contains(entry.el)) return;
    const list = entry.el.querySelector(":scope > .voice-users-list");
    const rows = list === null ? [] : Array.from(list.children);
    if (rows.some((r) => (r as HTMLElement).dataset.voiceUid === String(was.userId))) return;
    const next =
      rows.length > 0
        ? rows[Math.min(was.index, rows.length - 1)]
        : entry.el.querySelector(":scope > .channel-item");
    (next as HTMLElement | null | undefined)?.focus();
  }

  /** Run `updateVoiceRow` on every live voice wrapper: the cheap path for a
   *  change that leaves which channels are occupied as it was. */
  function refreshVoiceRows(): void {
    if (channelList === null) return;
    const focus = captureVoiceFocus();
    for (const { el, channel } of Array.from(voiceWrappers.values())) {
      if (channelList.contains(el)) updateVoiceRow(el, channel);
    }
    restoreVoiceFocus(focus);
  }

  function renderChannels(): void {
    const focus = captureVoiceFocus();
    drawChannels();
    restoreVoiceFocus(focus);
  }

  /** The channel list's inputs, read now (5.4d-1); 5.4d-2 hands them over from
   *  one `select`. The mute token is fixed: the mute list is read live through
   *  `listCtx.isMuted` and every mute event redraws. */
  const muteToken = {};
  function readListInputs(): ChannelListInputs {
    const channelsState = channelsStore.getState();
    return {
      channels: channelsState.channels,
      activeChannelId: channelsState.activeChannelId,
      selfRole: authStore.getState().user?.role ?? "",
      roles: channelsState.roles,
      collapsed: uiStore.getState().collapsedCategories,
      hideMuted: isHideMutedChannels(),
      mute: muteToken,
    };
  }
  const listCtx: ChannelListContext = {
    isMuted: isChannelMuted,
    canCreate: onCreateChannel !== undefined,
    canReorder: onReorderChannel !== undefined,
  };
  const UNCATEGORIZED_KEY = "\u0000uncategorized";

  function drawChannels(): void {
    // voiceSel exists from mount() on, which is also when channelList does.
    if (channelList === null || voiceSel === null) {
      return;
    }

    const list = readListInputs();
    const voice = voiceSel.get();
    const groups = channelGroups(list);

    if (groups.length === 0) {
      for (const child of Array.from(channelList.children)) {
        disposeOwned(child);
        child.remove();
      }
      const emptyState = createElement("div", { class: "channel-list-empty" });
      const msg = createElement(
        "p",
        { class: "channel-list-empty-text" },
        shellText("channel.empty"),
      );
      appendChildren(emptyState, msg);
      // With zero channels there is no category header, so the per-category
      // "+" (the only create affordance) never renders. Offer one here for a
      // manager; a non-manager gets the plain message (#9).
      if (onCreateChannel !== undefined && channelAccess(list).manageChannels) {
        const createBtn = createElement(
          "button",
          {
            type: "button",
            class: "channel-list-empty-create",
            "data-testid": "create-channel-empty",
          },
          shellText("channel.create"),
        );
        // Per-render owner so repeated empty-state renders do not stack
        // listeners on the factory-lifetime signal.
        const owner = new Disposable();
        ownerByEl.set(emptyState, owner);
        createBtn.addEventListener("click", () => onCreateChannel(""), { signal: owner.signal });
        emptyState.appendChild(createBtn);
      } else {
        emptyState.appendChild(
          createElement("p", { class: "channel-list-empty-hint" }, shellText("channel.emptyHint")),
        );
      }
      channelList.appendChild(emptyState);
      return;
    }
    channelList.querySelector(".channel-list-empty")?.remove();

    /** One group's rows, keyed and reused (B9-21). A collapsed category
     *  keeps only the rows `visibleRows` allows. */
    function reconcileRows(container: HTMLElement, g: ChannelGroup): void {
      const rows = visibleRows(g, list, voice, listCtx);
      const byId = new Map(rows.map((c) => [c.id, c]));
      const header = container.parentElement?.querySelector(".category") ?? null;
      const groupKey = g.name ?? UNCATEGORIZED_KEY;
      let shown = shownRowsByGroup.get(groupKey);
      if (shown === undefined) {
        shown = [];
        shownRowsByGroup.set(groupKey, shown);
      }
      shown.splice(0, shown.length, ...rows);
      const collapsed = g.name !== null && list.collapsed.has(g.name);
      // A focused row a collapsed category stops showing (read, muted, emptied)
      // hands focus to the category's arrow instead of dropping it to the page.
      // The row is the container's child holding focus, so a focused
      // participant counts for its voice channel: it sits beside that
      // channel's .channel-item, not inside it.
      const focused = document.activeElement;
      const holder =
        focused instanceof HTMLElement
          ? Array.from(container.children).find((child) => child.contains(focused))
          : undefined;
      const focusedRow =
        holder === undefined
          ? null
          : holder.matches(".channel-item")
            ? (holder as HTMLElement)
            : holder.querySelector<HTMLElement>(":scope > .channel-item");
      const losesFocus =
        focusedRow !== null && !rows.some((ch) => String(ch.id) === focusedRow.dataset.channelId);
      const lostIndex = losesFocus
        ? Array.from(container.querySelectorAll(".channel-item")).indexOf(focusedRow)
        : -1;
      reconcileModels<Channel, ChannelRowModel>(container, rows, {
        key: (ch) => String(ch.id),
        model: (ch) => channelRowModel(ch, g, list, listCtx),
        create: (model, atEvent) => {
          const ch = byId.get(model.channelId);
          // i18n-exempt: developer-facing invariant error, never shown to a user
          if (ch === undefined) throw new Error("channel row built for a channel not in the pass");
          const owner = new Disposable();
          const { signal } = owner;
          const el =
            model.kind === "voice" ? createVoiceRow(ch, signal) : drawTextChannelRow(model);
          if (model.kind !== "voice") {
            el.addEventListener("click", () => navigateToChannel(model.channelId), { signal });
          }
          attachChannelContextMenu(
            el,
            ch,
            signal,
            // Sidebar-lifetime signal (aborted only in destroy()) for anything
            // that owns DOM mounted outside this render's rows — a menu or
            // modal on document.body must not be torn down by an unrelated
            // re-render (OC-0281, OC-0282).
            disposable.signal,
            // A row now outlives a channel edit, so the actions take the live
            // channel, not the one this row was built for.
            onEditChannel === undefined ? undefined : () => onEditChannel(atEvent()),
            onDeleteChannel === undefined ? undefined : () => onDeleteChannel(atEvent()),
            onPurgeChannel === undefined
              ? undefined
              : (_channel, count) => onPurgeChannel(atEvent(), count),
            shown,
            onReorderChannel,
            onInviteFromChannel === undefined ? undefined : () => onInviteFromChannel(atEvent()),
            model.access,
          );
          attachDragHandlers(
            el,
            ch,
            container,
            g.channels,
            signal,
            disposable.signal,
            onReorderChannel,
            model.access.manageChannels,
          );
          ownerByEl.set(el, owner);
          return el;
        },
        // A reused voice wrapper brings its chrome and participants up to date.
        update: (el, ch, model) => {
          if (model.kind === "voice") updateVoiceRow(el, ch);
        },
        dispose: disposeOwned,
      });
      if (losesFocus) {
        // A hidden muted row in an expanded list hands focus to the row that
        // took its place; otherwise to the category's arrow.
        const left = container.querySelectorAll<HTMLElement>(".channel-item");
        const next =
          !collapsed && left.length > 0
            ? left[Math.min(Math.max(lostIndex, 0), left.length - 1)]
            : null;
        (next ?? header?.querySelector<HTMLElement>(".category-arrow"))?.focus();
      }
    }

    const groupsByKey = new Map(groups.map((g) => [g.name ?? UNCATEGORIZED_KEY, g]));
    reconcileModels<ChannelGroup, CategoryGroupModel>(channelList, groups, {
      key: (g) => g.name ?? UNCATEGORIZED_KEY,
      // A group rebuilds when its own header changes (collapse, the "+");
      // an unchanged group reuses its element and reconciles its rows in place.
      model: (g) => categoryGroupModel(g, list, listCtx),
      create: (model) => {
        const g = groupsByKey.get(model.name ?? UNCATEGORIZED_KEY);
        // i18n-exempt: developer-facing invariant error, never shown to a user
        if (g === undefined) throw new Error("category group built for a group not in the pass");
        return buildCategoryGroup(model, g, reconcileRows);
      },
      update: (el, g) => {
        const container = el.querySelector<HTMLElement>(".category-channels-container");
        if (container !== null) reconcileRows(container, g);
      },
      dispose: disposeOwned,
    });

    setRovingTabindex(channelList, ".channel-item");
  }

  /** Draw one category group from its model, bind its header, then fill its rows. */
  function buildCategoryGroup(
    model: CategoryGroupModel,
    g: ChannelGroup,
    reconcileRows: (container: HTMLElement, g: ChannelGroup) => void,
  ): HTMLDivElement {
    const group = drawCategoryGroup(model);
    const owner = new Disposable();
    ownerByEl.set(group, owner);
    const { signal } = owner;
    const name = model.name;

    if (name !== null) {
      const header = group.querySelector<HTMLElement>(":scope > .category");
      const arrow = header?.querySelector<HTMLElement>(":scope > .category-arrow") ?? null;
      if (header !== null && arrow !== null) {
        header.querySelector(":scope > .category-add-btn")?.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onCreateChannel?.(name);
          },
          { signal },
        );
        header.addEventListener("click", () => toggleCategory(name), { signal });
        attachCategoryContextMenu(header, arrow, name, signal, disposable.signal);
      }
    }

    const container = group.querySelector<HTMLElement>(":scope > .category-channels-container");
    // Populate through the reconciler so every row gets its key metadata; a
    // later in-place update can then recognise and reuse them.
    if (container !== null) reconcileRows(container, g);
    return group;
  }

  /** Redraw when a row's mute is toggled (see CHANNEL_MUTE_CHANGED). */
  function handleMuteChanged(): void {
    renderChannels();
  }

  /** Redraw when the Hide Muted Channels preference flips. */
  function handlePrefChanged(e: Event): void {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key === HIDE_MUTED_CHANNELS_KEY) renderChannels();
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });
    window.addEventListener("owncord:pref-change", handlePrefChanged, {
      signal: disposable.signal,
    });
    // The event is dispatched on window by the mute store, so every writer
    // (context menu, Settings unmute) redraws the rows (F16).
    window.addEventListener(CHANNEL_MUTE_CHANGED, handleMuteChanged, { signal: disposable.signal });

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    const authState = authStore.getState();
    serverNameEl = createElement(
      "h2",
      {},
      authState.serverName ?? shellText("common.serverNameFallback"),
    );
    header.appendChild(serverNameEl);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    // One Tab stop for the whole list; ArrowUp/Down step, Enter/Space open the
    // focused channel (B9-21). The listener lives on the list, which survives
    // every keyed re-render.
    enableRovingNavigation(channelList, ".channel-item", disposable.signal, "vertical");

    appendChildren(root, header, channelList);
    container.appendChild(root);

    // Everything the voice rows draw, as one selection over its sources
    // (5.4c-2). Created before the first render, which reads it, and owned
    // by the sidebar's lifetime signal, so destroy() releases it.
    voiceSel = select(
      [
        voiceStore,
        membersStore,
        authStore,
        channelsStore,
        uiStore,
        safetyStore,
        // A fresh token per event: localSilenced answers may differ after it.
        eventSource(USER_LOCAL_MUTE_CHANGED, () => ({})),
      ],
      projectVoiceInputs,
      (next, prev) => {
        // Collapsed and Hide Muted visibility follow occupancy, so a change
        // to it takes the full render; everything else (speaking, mute,
        // verification, connection, a rename) takes the cheap path.
        if (
          next.currentChannelId !== prev.currentChannelId ||
          occupiedKey(next) !== occupiedKey(prev)
        ) {
          renderChannels();
        } else {
          refreshVoiceRows();
        }
      },
      { signal: disposable.signal, equals: sameVoiceInputs },
    );

    // Initial render
    renderChannels();

    // Subscribe to channels store changes (channels map OR active channel)
    const unsubChannelsMap = channelsStore.subscribeSelector(
      (s) => s.channels,
      () => renderChannels(),
    );
    unsubscribers.push(unsubChannelsMap);
    const unsubActiveChannel = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => renderChannels(),
    );
    unsubscribers.push(unsubActiveChannel);

    // Subscribe to auth store for server name updates
    const unsubAuth = authStore.subscribeSelector(
      (s) => s.serverName,
      (serverName) => {
        if (serverNameEl !== null) {
          setText(serverNameEl, serverName ?? shellText("common.serverNameFallback"));
        }
      },
    );
    unsubscribers.push(unsubAuth);

    // Rows take channelAccess(list) from readListInputs() (and canModerateVoice()
    // is read only when the voice menu opens), but nothing above re-renders when
    // the role or its mask changes on its own: a self MEMBER_UPDATE or a
    // ROLES_UPDATE would leave the category "+", the channel menu and the
    // voice-moderation menu stale until an unrelated event fired (OC-0142).
    const unsubRole = authStore.subscribeSelector(
      (s) => s.user?.role ?? "",
      () => renderChannels(),
    );
    unsubscribers.push(unsubRole);
    const unsubRoles = channelsStore.subscribeSelector(
      (s) => s.roles,
      () => renderChannels(),
    );
    unsubscribers.push(unsubRoles);

    // Subscribe to UI store for category collapse changes
    const unsubUi = uiStore.subscribeSelector(
      (s) => s.collapsedCategories,
      () => renderChannels(),
    );
    unsubscribers.push(unsubUi);
  }

  function destroy(): void {
    // disposable.destroy() also releases this sidebar's hold on the shared document-level
    // drag listeners (drag-reorder.ts tracks owners by signal).
    disposable.destroy();
    closeProfilePopup?.();
    closeProfilePopup = null;
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    voiceRowByUserId.clear();
    voiceWrappers.clear();
    voiceSel = null;
    if (root !== null) {
      root.remove();
      root = null;
    }
    channelList = null;
    serverNameEl = null;
  }

  return { mount, destroy };
}
