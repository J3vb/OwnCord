/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users; a click joins, or opens the call once joined.
 * The voice rows draw from row models (features/channels/voiceRow*.ts) that
 * one `select` over their stores keeps current (5.4c-2).
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { reconcileChildren, reconcileModels, sameModel } from "@lib/reconcile";
import { select, eventSource, type Selection } from "@lib/select";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { channelsStore, getChannelsByCategory, categoryLabel } from "@stores/channels.store";
import { navigateToChannel } from "@lib/channel-navigation";
import { isChannelMuted } from "@lib/channel-mutes";
import { HIDE_MUTED_CHANNELS_KEY, hiddenByMute } from "@lib/hide-muted-channels";
import type { Channel, ChannelsState } from "@stores/channels.store";
import { authStore, getCurrentUser, type AuthState } from "@stores/auth.store";
import { uiStore, toggleCategory, isCategoryCollapsed, type UiState } from "@stores/ui.store";
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
import { roleHasPermission, canManageChannels, currentUserPermissions } from "@lib/permissions";
import { Permission } from "@lib/types";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";
import { joinRetryInMs } from "../features/voice/joinBackoff";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
// nsfwIndicator/privateIndicator: shared with the text rows until 5.4d moves them onto models.
import {
  drawVoiceChannelChrome,
  drawVoiceUserRow,
  nsfwIndicator,
  patchVoiceChannelChrome,
  patchVoiceUserRow,
  privateIndicator,
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

function renderTextChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
): HTMLDivElement {
  const classes = [
    "channel-item",
    isActive ? "active" : "",
    // A muted channel is quiet: no bold name and no pill for plain unread.
    // A mention is addressed to the reader, so it still lights the row.
    rowLooksUnread(channel) ? "unread" : "",
    channel.mentionCount > 0 ? "mentioned" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", {
    class: classes,
    "data-testid": `channel-${channel.id}`,
    // Roving list item: reachable by Tab once, then arrow-stepped (B9-21).
    role: "link",
    tabindex: "-1",
  });
  item.dataset.channelId = String(channel.id);
  item.setAttribute("aria-current", isActive ? "page" : "false");
  // The pill is drawn in CSS only, so name the unread state for screen
  // readers; a mention announces itself through its badge.
  if (rowLooksUnread(channel) && channel.mentionCount === 0) {
    item.setAttribute("aria-description", shellText("channel.unread"));
  }

  const prefix = createElement("span", { class: "ch-icon", "aria-hidden": "true" });
  if (channel.type === "announcement") {
    prefix.appendChild(createIcon("megaphone", 16));
  } else {
    prefix.textContent = "#";
  }
  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  // Age-restricted marker. Next to the name rather than replacing the "#", so
  // the channel still reads as a channel and the mark is visible whether or
  // not the reader has already accepted the gate this session.
  if (channel.nsfw) {
    item.appendChild(nsfwIndicator(channel.id));
  }
  if (channel.isPrivate) {
    item.appendChild(privateIndicator(channel.id));
  }

  // A server channel shows plain unread as a bold name and a white pill only
  // (Discord parity): the count is for mentions and for DMs. A mute silences
  // chatter, never something addressed to the reader, so the mention badge is
  // left alone.
  const muted = isChannelMuted(channel.id);
  if (muted) {
    item.classList.add("muted");
  }

  // The mention badge counts the mentions, not the messages.
  if (channel.mentionCount > 0) {
    const badge = createElement(
      "span",
      { class: "mention-badge", "data-testid": `channel-mentions-${channel.id}` },
      String(channel.mentionCount),
    );
    badge.title = shellText("channel.mentions", { count: channel.mentionCount });
    item.appendChild(badge);
  }

  item.addEventListener("click", () => navigateToChannel(channel.id), { signal });

  return item;
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

/** Whether a text-style row has unread messages; voice rows never do. */
function rowIsUnread(channel: Channel): boolean {
  return channel.type !== "voice" && channel.unreadCount > 0;
}

/**
 * Whether a row draws the "unread" class: a muted channel is quiet (no bold,
 * no pill) unless it has a mention. Every row that looks unread is also shown
 * under a collapsed category (see `rowVisibleWhenCollapsed`), so a collapsed
 * header needs no "unread hidden" marker.
 */
function rowLooksUnread(channel: Channel): boolean {
  return rowIsUnread(channel) && (!isChannelMuted(channel.id) || channel.mentionCount > 0);
}

/** Whether a voice channel has people in it, or is the one you are connected to. */
function voiceChannelOccupied(channelId: number): boolean {
  const voice = voiceStore.getState();
  return voice.currentChannelId === channelId || (voice.voiceUsers.get(channelId)?.size ?? 0) > 0;
}

/**
 * Whether a channel row still shows under a collapsed category: the channel
 * you are viewing, any mention (muted or not, a mention always shows), an
 * unread row that is not muted, and voice channels you are in or that have
 * people in them (Discord parity, so a live call stays visible).
 */
function rowVisibleWhenCollapsed(channel: Channel, activeChannelId: number | null): boolean {
  if (channel.id === activeChannelId) return true;
  if (channel.mentionCount > 0) return true;
  if (channel.type === "voice") return voiceChannelOccupied(channel.id);
  return rowIsUnread(channel) && !isChannelMuted(channel.id);
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

function renderChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
  /** Builds a voice channel's wrapper: its chrome, click and participant rows. */
  createVoiceRow: (channel: Channel, signal: AbortSignal) => HTMLDivElement,
  onEditChannel?: (channel: Channel) => void,
  onDeleteChannel?: (channel: Channel) => void,
  containerEl?: HTMLElement,
  channels?: readonly Channel[],
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  onPurgeChannel?: (channel: Channel, count: number) => Promise<void>,
  menuChannels: readonly Channel[] | undefined = channels,
  onInviteFromChannel?: (channel: Channel) => void,
): HTMLDivElement {
  const el =
    channel.type === "voice"
      ? createVoiceRow(channel, signal)
      : renderTextChannelItem(channel, isActive, signal);
  attachChannelContextMenu(
    el,
    channel,
    signal,
    lifetimeSignal,
    onEditChannel,
    onDeleteChannel,
    onPurgeChannel,
    menuChannels,
    onReorderChannel,
    onInviteFromChannel,
  );
  if (containerEl !== undefined && channels !== undefined) {
    attachDragHandlers(
      el,
      channel,
      containerEl,
      channels,
      signal,
      lifetimeSignal,
      onReorderChannel,
    );
  }
  return el;
}

/**
 * Everything a channel row renders, as one string. A changed value rebuilds
 * just that row (B9-21); an unchanged value reuses the node, so focus, a
 * hovered/open state and the scroll position all survive an unrelated update.
 *
 * The group's channel order is folded in so a reorder rebuilds the affected
 * rows: each row's drag handler captures the ordered channel array at attach
 * time, and a reused node would otherwise drop against a stale order.
 *
 * A voice row's participants and live state are not in it: they are drawn
 * from row models (`updateVoiceRow`), which patch or rebuild only the part
 * that changed, so a voice wrapper keeps its node like a text row.
 */
function channelRowSignature(
  channel: Channel,
  activeChannelId: number | null,
  orderIds: string,
): string {
  return [
    channel.id,
    channel.name,
    channel.type,
    channel.nsfw ? "n" : "",
    channel.isPrivate ? "p" : "",
    channel.voiceMaxUsers,
    activeChannelId === channel.id ? "a" : "",
    isChannelMuted(channel.id) ? "m" : "",
    channel.unreadCount,
    channel.mentionCount,
    orderIds,
  ].join("|");
}

interface GroupRender {
  /** Category name, or null for the uncategorized group. */
  readonly name: string | null;
  readonly channels: readonly Channel[];
  readonly orderIds: string;
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
    const wrapper =
      inputs === undefined
        ? createElement("div", {})
        : drawVoiceChannelChrome(voiceChannelChrome(channel, inputs));
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

  function drawChannels(): void {
    if (channelList === null) {
      return;
    }

    const grouped = getChannelsByCategory();
    const activeChannelId = channelsStore.getState().activeChannelId;

    if (grouped.size === 0) {
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
      if (onCreateChannel !== undefined && canManageChannels()) {
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

    const canManage = canManageChannels();
    const canModerate = canModerateVoice();
    const permissions = currentUserPermissions();

    // One entry per category, in the map's order; the null key is the
    // uncategorized group.
    const groups: GroupRender[] = [];
    for (const [category, channels] of grouped) {
      groups.push({ name: category, channels, orderIds: channels.map((c) => c.id).join(",") });
    }

    /** One group's rows, keyed and reused (B9-21). A collapsed category
     *  keeps only the rows `rowVisibleWhenCollapsed` allows. */
    function reconcileRows(container: HTMLElement, g: GroupRender): void {
      const collapsed = g.name !== null && isCategoryCollapsed(g.name);
      // Hide Muted Channels drops muted rows here, not from `g.channels`: the
      // header (kept even when every row is hidden) and the drag-reorder maths
      // still see the whole category.
      const rows = g.channels.filter(
        (ch) =>
          !hiddenByMute(ch, activeChannelId, voiceChannelOccupied) &&
          (!collapsed || rowVisibleWhenCollapsed(ch, activeChannelId)),
      );
      const header = container.parentElement?.querySelector(".category") ?? null;
      const groupKey = g.name ?? "\u0000uncategorized";
      let shown = shownRowsByGroup.get(groupKey);
      if (shown === undefined) {
        shown = [];
        shownRowsByGroup.set(groupKey, shown);
      }
      shown.splice(0, shown.length, ...rows);
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
      reconcileChildren(container, rows, {
        key: (ch) => String(ch.id),
        signature: (ch) => channelRowSignature(ch, activeChannelId, g.orderIds),
        create: (ch) => {
          const owner = new Disposable();
          const el = renderChannelItem(
            ch,
            ch.id === activeChannelId,
            owner.signal,
            // Sidebar-lifetime signal (aborted only in destroy()) for anything
            // that owns DOM mounted outside this render's rows — a menu or
            // modal on document.body must not be torn down by an unrelated
            // re-render (OC-0281, OC-0282).
            disposable.signal,
            createVoiceRow,
            onEditChannel,
            onDeleteChannel,
            container,
            g.channels,
            onReorderChannel,
            onPurgeChannel,
            shown,
            onInviteFromChannel,
          );
          ownerByEl.set(el, owner);
          return el;
        },
        // A reused voice wrapper brings its chrome and participants up to date.
        update: (el, ch) => {
          if (ch.type === "voice") updateVoiceRow(el, ch);
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

    reconcileChildren(channelList, groups, {
      key: (g) => g.name ?? "\u0000uncategorized",
      // A group rebuilds when its own chrome or permission-dependent
      // affordances change; an unchanged group reuses its element and
      // reconciles its rows in place.
      signature: (g) =>
        [
          g.name ?? "",
          g.name !== null && isCategoryCollapsed(g.name) ? "c" : "e",
          canManage ? "C" : "",
          canModerate ? "M" : "",
          permissions,
        ].join("|"),
      create: (g) => buildCategoryGroup(g, reconcileRows),
      update: (el, g) => {
        const container = el.querySelector<HTMLElement>(".category-channels-container");
        if (container !== null) reconcileRows(container, g);
      },
      dispose: disposeOwned,
    });

    setRovingTabindex(channelList, ".channel-item");
  }

  /** Build the header and rows for one category group. */
  function buildCategoryGroup(
    g: GroupRender,
    reconcileRows: (container: HTMLElement, g: GroupRender) => void,
  ): HTMLDivElement {
    const group = createElement("div", {});
    const owner = new Disposable();
    ownerByEl.set(group, owner);
    const { signal } = owner;

    if (g.name !== null) {
      const collapsed = isCategoryCollapsed(g.name);
      const header = createElement("div", {
        class: collapsed ? "category collapsed" : "category",
      });
      header.dataset.category = g.name;
      const categoryNameId = `category-name-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

      // The arrow is the keyboard-operated collapse control; the header div
      // itself keeps its mouse click handler. A real <button> here (rather
      // than making the whole header a button) keeps the header's own "+" from
      // being an interactive element nested inside another one. The label
      // names the arrow (aria-labelledby), so no second copy of the category
      // name is needed.
      const label = createElement(
        "span",
        { class: "category-name", id: categoryNameId },
        categoryLabel(g.name),
      );
      const arrow = createElement("button", {
        type: "button",
        class: "category-arrow",
        "aria-expanded": collapsed ? "false" : "true",
        "aria-labelledby": categoryNameId,
      });
      arrow.appendChild(createIcon(collapsed ? "chevron-right" : "chevron-down", 12));

      appendChildren(header, arrow, label);

      if (onCreateChannel !== undefined && canManageChannels()) {
        const addBtn = createElement(
          "button",
          {
            type: "button",
            class: "category-add-btn",
            title: shellText("channel.create"),
            "aria-label": shellText("channel.create"),
            "data-testid": `create-channel-${g.name.toLowerCase().replace(/\s+/g, "-")}`,
          },
          "+",
        );
        addBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onCreateChannel(g.name!);
          },
          { signal },
        );
        header.appendChild(addBtn);
      }

      header.addEventListener(
        "click",
        () => {
          toggleCategory(g.name!);
        },
        { signal },
      );

      attachCategoryContextMenu(header, arrow, g.name, signal, disposable.signal);

      group.appendChild(header);
    }

    // Built even when collapsed: the joined voice channel stays visible there,
    // and a later join or leave reconciles this container in place.
    const container = createElement("div", { class: "category-channels-container" });
    // Populate through the reconciler so every row gets its key metadata; a
    // later in-place update can then recognise and reuse them.
    group.appendChild(container);
    reconcileRows(container, g);

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

    // canManageChannels()/canModerateVoice() read authStore.user.role and
    // channelsStore.roles at render time, but nothing above re-renders when
    // either changes on its own — a MEMBER_UPDATE for the signed-in user
    // (dispatcher.ts's self-branch) or a ROLES_UPDATE permission-mask edit
    // would otherwise leave the category "+", the channel context menu and
    // the voice-moderation menu stale until an unrelated channel/voice event
    // happened to fire renderChannels() (OC-0142).
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
