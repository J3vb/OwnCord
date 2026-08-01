/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users and join/leave on click.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { channelsStore, getChannelsByCategory } from "@stores/channels.store";
import { navigateToChannel } from "@lib/channel-navigation";
import { markAllRead, unreadChannelIds } from "@lib/read-state";
import { dmStore } from "@stores/dm.store";
import type { Channel } from "@stores/channels.store";
import { authStore, getCurrentUser } from "@stores/auth.store";
import { uiStore, toggleCategory, isCategoryCollapsed } from "@stores/ui.store";
import { voiceStore, getChannelVoiceUsers, getPeerVerification } from "@stores/voice.store";
import type { PeerVerification, VoiceUser } from "@stores/voice.store";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { attachStreamPreview, attachScrollCollapse } from "@lib/streamPreview";
import { showUserVolumeMenu } from "./channel-sidebar/volume-menu";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";
import { attachChannelContextMenu } from "./channel-sidebar/context-menu";
import { attachDragHandlers, releaseGlobalDragListeners } from "./channel-sidebar/drag-reorder";
import { rePinPeerIdentity } from "@lib/livekitSession";
import { createIdentityMismatchModal } from "./CertMismatchModal";
import { createLogger } from "@lib/logger";
import { membersStore } from "@stores/members.store";
import { roleHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { importIdentityPublicKey, computeKeyFingerprint } from "@lib/e2eeCrypto";

const log = createLogger("ChannelSidebar");

/** Icon, color, and tooltip for a peer's E2EE identity verification badge
 *  (F3 TOFU). The three states mirror the voice store's PeerVerification:
 *  a green shield-check when the announce signature verified against the pinned
 *  key, a muted shield when the peer published no key (legacy), and a red
 *  shield-alert when the delivered key differs from the pinned one. */
function verifyPresentation(v: PeerVerification): {
  icon: IconName;
  color: string;
  title: string;
} {
  if (v.status === "verified") {
    return {
      icon: "shield-check",
      color: "var(--green, #23a559)",
      title:
        v.safetyNumber !== null
          ? `Identity verified · Safety number: ${v.safetyNumber}`
          : "Identity verified",
    };
  }
  if (v.status === "mismatch") {
    return {
      icon: "shield-alert",
      color: "var(--red, #f23f43)",
      title: "Identity key changed — click to review and re-pin",
    };
  }
  // "unverified" — the remaining status: peer published no identity key (legacy).
  return {
    icon: "shield",
    color: "var(--text-muted, #949ba4)",
    title: "Identity not verified — this participant published no key",
  };
}

// Identity-mismatch re-pin modal (F3 TOFU). One instance at a time, mounted on
// document.body; torn down on re-open and when the owning sidebar aborts.
// ponytail: module-level singleton mirrors ./channel-sidebar/volume-menu — there
// is only ever one sidebar. Extract to its own submodule if that ever changes.
let activeIdentityModal: MountableComponent | null = null;

function closeIdentityModal(): void {
  if (activeIdentityModal !== null) {
    activeIdentityModal.destroy?.();
    activeIdentityModal = null;
  }
}

async function openIdentityMismatchModal(
  userId: number,
  username: string,
  signal: AbortSignal,
): Promise<void> {
  closeIdentityModal();
  // Compute the newly-delivered key's fingerprint so the user can verify it
  // out-of-band before trusting — the whole purpose of the mismatch prompt (the
  // same importIdentityPublicKey→computeKeyFingerprint round-trip verifyPeerAnnounce
  // runs on the verified path). Without it the modal's "verify out-of-band"
  // instruction is unfollowable and "Trust New Key" is a blind accept.
  let fingerprint: string | null = null;
  const publishedKey = membersStore.getState().members.get(userId)?.identityPublicKey ?? null;
  if (publishedKey !== null) {
    try {
      fingerprint = await computeKeyFingerprint(await importIdentityPublicKey(publishedKey));
    } catch (err) {
      log.warn("E2EE: could not compute changed-key fingerprint for re-pin modal", err);
    }
  }
  // The sidebar (or a newer open) may have superseded us during the async compute.
  if (signal.aborted) return;
  closeIdentityModal();
  const modal = createIdentityMismatchModal({
    username,
    fingerprint,
    onAccept: () => {
      closeIdentityModal();
      // Pin the EXACT key whose fingerprint we displayed and the user verified
      // out-of-band (captured above), NOT a fresh membersStore re-read — a
      // malicious server could mutate the store (user_update) during the human
      // verification window and get its key pinned instead (TOCTOU).
      //
      // Only pin a key whose fingerprint was actually SHOWN: publishedKey null
      // means the server stripped the key, and fingerprint null means it could
      // not be computed (malformed key). In both cases the user saw nothing to
      // verify, so pinning would be a blind accept — refuse it.
      if (publishedKey === null || fingerprint === null) return;
      // Surface keyring/IO failures instead of dropping them — this re-pins a
      // trust anchor, so a silent failure would leave the user believing they
      // recovered when they did not.
      void rePinPeerIdentity(userId, publishedKey).catch((err: unknown) => {
        log.error("E2EE: failed to re-pin peer identity", err);
      });
    },
    onReject: () => {
      closeIdentityModal();
    },
  });
  modal.mount(document.body);
  activeIdentityModal = modal;
  // Close if the owning sidebar is destroyed while the modal is still open.
  signal.addEventListener("abort", closeIdentityModal, { once: true });
}

export interface ChannelReorderData {
  readonly channelId: number;
  readonly newPosition: number;
}

/** Moderator actions on another user's voice session. Supplied by the page,
 *  which owns the WS socket; the sidebar only decides whether to offer them. */
export interface VoiceModerationCallbacks {
  readonly onServerMute: (channelId: number, userId: number, muted: boolean) => void;
  readonly onServerDeafen: (channelId: number, userId: number, deafened: boolean) => void;
  readonly onMove: (userId: number, toChannelId: number) => void;
  readonly onDisconnect: (userId: number) => void;
}

/** Whether the signed-in user's role holds MUTE_MEMBERS. The server enforces
 *  it (and the rank rule the client cannot evaluate); this only decides whether
 *  the menu is worth offering. Derived through the same helper as the
 *  member-list moderation gates so the two cannot disagree about who is a
 *  moderator. */
export function canModerateVoice(): boolean {
  const role = getCurrentUser()?.role ?? "";
  return roleHasPermission(role, Permission.MUTE_MEMBERS);
}

export interface ChannelSidebarOptions {
  readonly onVoiceJoin: (channelId: number) => void;
  readonly onVoiceLeave: () => void;
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
  /** Called when the user clicks a voice user row to watch their stream. */
  readonly onWatchStream?: (userId: number) => void;
}

const AVATAR_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

function pickAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#5865f2";
}

function renderTextChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
): HTMLDivElement {
  const classes = [
    "channel-item",
    isActive ? "active" : "",
    channel.unreadCount > 0 ? "unread" : "",
    channel.mentionCount > 0 ? "mentioned" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", { class: classes, "data-testid": `channel-${channel.id}` });
  item.dataset.channelId = String(channel.id);

  const prefix = createElement("span", { class: "ch-icon" });
  if (channel.type === "announcement") {
    prefix.appendChild(createIcon("megaphone", 16));
  } else {
    prefix.textContent = "#";
  }
  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  // A mention badge outranks the plain unread badge: only one is shown, and
  // it counts the mentions, not the messages.
  if (channel.mentionCount > 0) {
    const badge = createElement(
      "span",
      { class: "mention-badge", "data-testid": `channel-mentions-${channel.id}` },
      String(channel.mentionCount),
    );
    badge.title = `${channel.mentionCount} mention${channel.mentionCount === 1 ? "" : "s"}`;
    item.appendChild(badge);
  } else if (channel.unreadCount > 0) {
    const badge = createElement("span", { class: "unread-badge" }, String(channel.unreadCount));
    item.appendChild(badge);
  }

  item.addEventListener("click", () => navigateToChannel(channel.id), { signal });

  return item;
}

/** Moderation section for one participant row, or undefined when the local
 *  user may not moderate voice (which hides the section entirely). Move targets
 *  are the other voice channels; the server re-checks that the TARGET may
 *  connect to the one picked. */
function buildVoiceModOptions(
  channelId: number,
  user: VoiceUser,
  cb?: VoiceModerationCallbacks,
): VoiceModMenuOptions | undefined {
  if (cb === undefined || !canModerateVoice()) return undefined;
  const moveTargets = Array.from(channelsStore.getState().channels.values())
    .filter((ch) => ch.type === "voice" && ch.id !== channelId)
    .map((ch) => ({ id: ch.id, name: ch.name }));
  return {
    serverMuted: user.serverMuted === true,
    serverDeafened: user.serverDeafened === true,
    moveTargets,
    onServerMute: (muted) => cb.onServerMute(channelId, user.userId, muted),
    onServerDeafen: (deafened) => cb.onServerDeafen(channelId, user.userId, deafened),
    onMove: (toChannelId) => cb.onMove(user.userId, toChannelId),
    onDisconnect: () => cb.onDisconnect(user.userId),
  };
}

function renderVoiceChannelItem(
  channel: Channel,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
  onWatchStream?: (userId: number) => void,
  onVoiceModerate?: VoiceModerationCallbacks,
): HTMLDivElement {
  const voiceState = voiceStore.getState();
  const isJoined = voiceState.currentChannelId === channel.id;
  // Freeze the join/leave affordance while the WS socket is not live — the same
  // disabled-with-reason pattern the VoiceWidget uses for its in-call controls
  // (docs/architecture/ux/README.md §3). LiveKit keeps retrying underneath; we
  // only gate the UI so the click isn't a silent no-op.
  const connectionStatus = uiStore.getState().connectionStatus;
  const frozen = connectionStatus !== "connected";
  const frozenReason = connectionStatus === "reconnecting" ? "Reconnecting…" : "Not connected";

  const wrapper = createElement("div", {});

  const classes = ["channel-item", "voice", isJoined ? "active" : "", frozen ? "disabled" : ""]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", { class: classes, "data-testid": `channel-${channel.id}` });
  item.dataset.channelId = String(channel.id);
  if (frozen) {
    item.title = frozenReason;
    item.setAttribute("aria-disabled", "true");
  }

  const prefix = createElement("span", { class: "ch-icon" });
  prefix.appendChild(createIcon("volume-2", 16));
  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  item.addEventListener(
    "click",
    () => {
      // Frozen while the WS socket is down — no-op; the reason is shown via title.
      if (uiStore.getState().connectionStatus !== "connected") return;
      if (isJoined) {
        onVoiceLeave();
      } else {
        onVoiceJoin(channel.id);
      }
    },
    { signal },
  );

  wrapper.appendChild(item);

  // Render connected voice users below the channel
  const voiceUsers = getChannelVoiceUsers(channel.id);
  if (voiceUsers.length > 0) {
    const usersContainer = createElement("div", { class: "voice-users-list" });
    for (const user of voiceUsers) {
      const rowClasses = user.speaking ? "voice-user-item speaking" : "voice-user-item";
      const row = createElement("div", {
        class: rowClasses,
        "data-voice-uid": String(user.userId),
      });

      const initial = user.username.length > 0 ? user.username.charAt(0).toUpperCase() : "?";
      const avatar = createElement("div", { class: "vu-avatar" }, initial);
      avatar.style.background = pickAvatarColor(user.username);
      row.appendChild(avatar);

      const nameEl = createElement("span", { class: "vu-name" }, user.username || "Unknown");
      row.appendChild(nameEl);

      if (user.camera) {
        const cameraIcon = createElement("span", { class: "vu-status" });
        cameraIcon.appendChild(createIcon("camera", 14));
        row.appendChild(cameraIcon);
      }

      if (user.screenshare) {
        const screenIcon = createElement("span", { class: "vu-status" });
        screenIcon.appendChild(createIcon("monitor", 14));
        row.appendChild(screenIcon);

        const liveBadge = createElement("span", { class: "vu-live-badge" }, "LIVE");
        row.appendChild(liveBadge);
      }

      // A moderator-imposed mute/deafen gets its own class and tooltip: the
      // same mic-off glyph would otherwise read as an ordinary self-mute.
      if (user.deafened) {
        const muteIcon = createElement("span", {
          class: user.serverMuted === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverMuted === true) muteIcon.title = "Muted by a moderator";
        muteIcon.appendChild(createIcon("mic-off", 14));
        const deafIcon = createElement("span", {
          class: user.serverDeafened === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverDeafened === true) deafIcon.title = "Deafened by a moderator";
        deafIcon.appendChild(createIcon("headphones-off", 14));
        row.appendChild(muteIcon);
        row.appendChild(deafIcon);
      } else if (user.muted) {
        const muteIcon = createElement("span", {
          class: user.serverMuted === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverMuted === true) muteIcon.title = "Muted by a moderator";
        muteIcon.appendChild(createIcon("mic-off", 14));
        row.appendChild(muteIcon);
      }

      // E2EE identity verification badge (F3 TOFU). Absent until the peer's
      // announce resolves; the local user is never in peerVerifications.
      const verification = getPeerVerification(user.userId);
      if (verification !== null) {
        const {
          icon: badgeIcon,
          color: badgeColor,
          title: badgeTitle,
        } = verifyPresentation(verification);
        const badge = createElement("span", { class: `vu-verify ${verification.status}` });
        badge.style.color = badgeColor;
        badge.title = badgeTitle;
        badge.appendChild(createIcon(badgeIcon, 14));
        if (verification.status === "mismatch") {
          badge.style.cursor = "pointer";
          badge.addEventListener(
            "click",
            (e) => {
              e.stopPropagation();
              void openIdentityMismatchModal(user.userId, user.username || "Unknown", signal);
            },
            { signal },
          );
        }
        row.appendChild(badge);
      }

      // Right-click for per-user volume (skip for own user)
      const currentUser = getCurrentUser();
      if (currentUser === null || currentUser.id !== user.userId) {
        row.addEventListener(
          "contextmenu",
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            showUserVolumeMenu(
              user.userId,
              user.username || "Unknown",
              e.clientX,
              e.clientY,
              signal,
              buildVoiceModOptions(channel.id, user, onVoiceModerate),
            );
          },
          { signal },
        );
      }

      // Click to watch stream (if user has camera or screenshare)
      if (onWatchStream !== undefined && (user.camera || user.screenshare)) {
        row.addEventListener(
          "click",
          (e) => {
            // Don't trigger if the right-click menu is open
            if (e.button !== 0) return;
            e.stopPropagation();
            const tileId = user.screenshare
              ? user.userId + SCREENSHARE_TILE_ID_OFFSET
              : user.userId;
            onWatchStream(tileId);
          },
          { signal },
        );
        row.style.cursor = "pointer";
      }

      // Hover/focus preview for remote users with video
      if (
        (currentUser === null || currentUser.id !== user.userId) &&
        (user.camera || user.screenshare)
      ) {
        const tileId = user.screenshare ? user.userId + SCREENSHARE_TILE_ID_OFFSET : user.userId;
        attachStreamPreview(
          row,
          user.userId,
          user.username || "Unknown",
          user.screenshare,
          user.camera,
          signal,
          () => {
            // Placeholder click: join voice channel and watch stream
            // Only join if not already in this channel
            if (voiceStore.getState().currentChannelId !== channel.id) {
              onVoiceJoin(channel.id);
            }
            if (onWatchStream !== undefined) onWatchStream(tileId);
          },
          onWatchStream !== undefined ? () => onWatchStream(tileId) : undefined,
        );
      }

      usersContainer.appendChild(row);
    }
    attachScrollCollapse(usersContainer, signal);
    wrapper.appendChild(usersContainer);
  }

  return wrapper;
}

function renderChannelItem(
  channel: Channel,
  isActive: boolean,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
  onEditChannel?: (channel: Channel) => void,
  onDeleteChannel?: (channel: Channel) => void,
  containerEl?: HTMLElement,
  channels?: readonly Channel[],
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  onWatchStream?: (userId: number) => void,
  onVoiceModerate?: VoiceModerationCallbacks,
  onPurgeChannel?: (channel: Channel, count: number) => Promise<void>,
): HTMLDivElement {
  let el: HTMLDivElement;
  if (channel.type === "voice") {
    el = renderVoiceChannelItem(
      channel,
      signal,
      onVoiceJoin,
      onVoiceLeave,
      onWatchStream,
      onVoiceModerate,
    );
  } else {
    el = renderTextChannelItem(channel, isActive, signal);
  }
  attachChannelContextMenu(el, channel, signal, onEditChannel, onDeleteChannel, onPurgeChannel);
  if (containerEl !== undefined && channels !== undefined) {
    attachDragHandlers(el, channel, containerEl, channels, signal, onReorderChannel);
  }
  return el;
}

function renderCategoryGroup(
  categoryName: string | null,
  channels: readonly Channel[],
  activeChannelId: number | null,
  signal: AbortSignal,
  onVoiceJoin: (channelId: number) => void,
  onVoiceLeave: () => void,
  onCreateChannel?: (category: string) => void,
  onEditChannel?: (channel: Channel) => void,
  onDeleteChannel?: (channel: Channel) => void,
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  onWatchStream?: (userId: number) => void,
  onVoiceModerate?: VoiceModerationCallbacks,
  onPurgeChannel?: (channel: Channel, count: number) => Promise<void>,
): HTMLDivElement {
  const group = createElement("div", {});

  if (categoryName !== null) {
    const collapsed = isCategoryCollapsed(categoryName);
    const header = createElement("div", {
      class: collapsed ? "category collapsed" : "category",
    });
    header.dataset.category = categoryName;

    const arrow = createElement("span", { class: "category-arrow" });
    arrow.appendChild(createIcon(collapsed ? "chevron-right" : "chevron-down", 12));
    const label = createElement("span", { class: "category-name" }, categoryName);

    appendChildren(header, arrow, label);

    if (onCreateChannel !== undefined) {
      const user = getCurrentUser();
      const role = user?.role?.toLowerCase() ?? "";
      // MANAGE_CHANNELS is enforced server-side on /admin/api/channels*, so
      // gate on the bit; the role-name check only stands in when the `ready`
      // role list has no entry for this role.
      const canManageChannels = roleHasPermission(role, Permission.MANAGE_CHANNELS);

      if (canManageChannels) {
        const addBtn = createElement(
          "span",
          {
            class: "category-add-btn",
            title: "Create Channel",
            "data-testid": `create-channel-${categoryName.toLowerCase().replace(/\s+/g, "-")}`,
          },
          "+",
        );
        addBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onCreateChannel(categoryName);
          },
          { signal },
        );
        header.appendChild(addBtn);
      }
    }

    header.addEventListener(
      "click",
      () => {
        toggleCategory(categoryName);
      },
      { signal },
    );

    group.appendChild(header);

    if (!collapsed) {
      const channelsContainer = createElement("div", { class: "category-channels-container" });
      for (const ch of channels) {
        channelsContainer.appendChild(
          renderChannelItem(
            ch,
            ch.id === activeChannelId,
            signal,
            onVoiceJoin,
            onVoiceLeave,
            onEditChannel,
            onDeleteChannel,
            channelsContainer,
            channels,
            onReorderChannel,
            onWatchStream,
            onVoiceModerate,
            onPurgeChannel,
          ),
        );
      }
      group.appendChild(channelsContainer);
    }
  } else {
    // Uncategorized channels render directly
    const channelsContainer = createElement("div", { class: "category-channels-container" });
    for (const ch of channels) {
      channelsContainer.appendChild(
        renderChannelItem(
          ch,
          ch.id === activeChannelId,
          signal,
          onVoiceJoin,
          onVoiceLeave,
          onEditChannel,
          onDeleteChannel,
          channelsContainer,
          channels,
          onReorderChannel,
          onWatchStream,
          onVoiceModerate,
          onPurgeChannel,
        ),
      );
    }
    group.appendChild(channelsContainer);
  }

  return group;
}

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const {
    onVoiceJoin,
    onVoiceLeave,
    onCreateChannel,
    onEditChannel,
    onDeleteChannel,
    onReorderChannel,
    onWatchStream,
    onVoiceModerate,
    onPurgeChannel,
  } = options;
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let channelList: HTMLDivElement | null = null;
  let serverNameEl: HTMLSpanElement | null = null;
  let markAllBtn: HTMLButtonElement | null = null;

  const unsubscribers: Array<() => void> = [];

  /** Voice-user rows from the last render, keyed by user id — lets the
   *  speaking-only subscription patch classes without per-user querySelector. */
  const voiceRowByUserId = new Map<number, HTMLElement>();

  function rebuildVoiceRowCache(): void {
    voiceRowByUserId.clear();
    if (channelList === null) return;
    for (const row of channelList.querySelectorAll<HTMLElement>(
      ".voice-user-item[data-voice-uid]",
    )) {
      voiceRowByUserId.set(Number(row.dataset.voiceUid), row);
    }
  }

  /** Hide Mark All as Read while nothing is unread — a header button that can
   *  never do anything is worse than no button. */
  function updateMarkAllBtn(): void {
    if (markAllBtn === null) return;
    markAllBtn.classList.toggle("visible", unreadChannelIds().length > 0);
  }

  function renderChannels(): void {
    updateMarkAllBtn();
    if (channelList === null) {
      return;
    }
    clearChildren(channelList);
    voiceRowByUserId.clear();

    const grouped = getChannelsByCategory();
    const state = channelsStore.getState();

    if (grouped.size === 0) {
      const emptyState = createElement("div", { class: "channel-list-empty" });
      const msg = createElement("p", { class: "channel-list-empty-text" }, "No channels yet");
      const hint = createElement(
        "p",
        { class: "channel-list-empty-hint" },
        "Right-click a category to create one",
      );
      appendChildren(emptyState, msg, hint);
      channelList.appendChild(emptyState);
      return;
    }

    for (const [category, channels] of grouped) {
      channelList.appendChild(
        renderCategoryGroup(
          category,
          channels,
          state.activeChannelId,
          ac.signal,
          onVoiceJoin,
          onVoiceLeave,
          onCreateChannel,
          onEditChannel,
          onDeleteChannel,
          onReorderChannel,
          onWatchStream,
          onVoiceModerate,
          onPurgeChannel,
        ),
      );
    }

    rebuildVoiceRowCache();
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    const authState = authStore.getState();
    serverNameEl = createElement("h2", {}, authState.serverName ?? "Server Name");
    header.appendChild(serverNameEl);

    // Mark All as Read lives on the server header — it is a server-wide action,
    // and it only appears while something is actually unread so the header does
    // not carry a permanently dead button.
    markAllBtn = createElement("button", {
      class: "sidebar-mark-all-read",
      title: "Mark All as Read",
      "aria-label": "Mark All as Read",
      "data-testid": "mark-all-read",
    });
    markAllBtn.appendChild(createIcon("check", 16));
    markAllBtn.addEventListener(
      "click",
      (e: Event) => {
        e.stopPropagation();
        markAllRead();
      },
      { signal: ac.signal },
    );
    header.appendChild(markAllBtn);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    appendChildren(root, header, channelList);
    container.appendChild(root);

    // Initial render
    renderChannels();

    // DM badges live in dm.store, and Mark All as Read covers them too, so the
    // header button's visibility has to track that store as well.
    unsubscribers.push(dmStore.subscribeSelector((s) => s.channels, updateMarkAllBtn));

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
          setText(serverNameEl, serverName ?? "Server Name");
        }
      },
    );
    unsubscribers.push(unsubAuth);

    // Subscribe to UI store for category collapse changes
    const unsubUi = uiStore.subscribeSelector(
      (s) => s.collapsedCategories,
      () => renderChannels(),
    );
    unsubscribers.push(unsubUi);

    // Re-render voice rows when the WS connection status flips so the join/leave
    // affordance freezes/unfreezes with a visible reason (§3 connection status).
    const unsubConnStatus = uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      () => renderChannels(),
    );
    unsubscribers.push(unsubConnStatus);

    // Subscribe to voice store, split in two:
    //  (a) a structural selector (who is in which channel + mute/deafen/camera/
    //      screenshare + E2EE verification, excluding `speaking`) that does a
    //      full re-render;
    //  (b) a speaking-only patcher that toggles CSS classes on rows cached at
    //      render time, so a speaker event never destroys DOM elements (which
    //      kills hover) and never pays a per-user querySelector.
    const unsubVoiceStructure = voiceStore.subscribeSelector(
      (state) => {
        let structSig = String(state.currentChannelId ?? "");
        for (const [chId, users] of state.voiceUsers) {
          structSig += `|${chId}`;
          for (const [uid, u] of users) {
            // Include the E2EE verification status so a verified↔unverified↔mismatch
            // flip re-renders the badge (it lives outside voiceUsers, in peerVerifications).
            const verif = state.peerVerifications?.get(uid);
            structSig += `:${uid}${u.muted ? "m" : ""}${u.deafened ? "d" : ""}${u.camera ? "c" : ""}${u.screenshare ? "s" : ""}${u.serverMuted === true ? "M" : ""}${u.serverDeafened === true ? "D" : ""}${verif ? `@${verif.status}` : ""}`;
          }
        }
        return structSig;
      },
      () => renderChannels(),
    );
    unsubscribers.push(unsubVoiceStructure);

    // Registered after the structural subscription so a structural change in
    // the same notification re-renders (and refreshes the row cache) first.
    const unsubSpeaking = voiceStore.subscribe((state) => {
      for (const [, users] of state.voiceUsers) {
        for (const [uid, u] of users) {
          const row = voiceRowByUserId.get(uid);
          if (row !== undefined) {
            row.classList.toggle("speaking", u.speaking);
          }
        }
      }
    });
    unsubscribers.push(unsubSpeaking);
  }

  function destroy(): void {
    ac.abort();
    releaseGlobalDragListeners(channelList ?? undefined);
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    voiceRowByUserId.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    channelList = null;
    serverNameEl = null;
    markAllBtn = null;
  }

  return { mount, destroy };
}
