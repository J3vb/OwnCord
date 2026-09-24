/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users and join/leave on click.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { reconcileChildren } from "@lib/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { createIcon, type IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { channelsStore, getChannelsByCategory, categoryLabel } from "@stores/channels.store";
import { navigateToChannel } from "@lib/channel-navigation";
import { markAllRead, unreadChannelIds } from "@lib/read-state";
import { isChannelMuted } from "@lib/channel-mutes";
import { dmStore } from "@stores/dm.store";
import type { Channel } from "@stores/channels.store";
import { authStore, getCurrentUser } from "@stores/auth.store";
import { uiStore, toggleCategory, isCategoryCollapsed } from "@stores/ui.store";
import { safetyStore } from "../features/safety/store";
import { formatUntil, safetyText } from "../i18n/safety";
import { voiceStore, getChannelVoiceUsers, getPeerVerification } from "@stores/voice.store";
import type { PeerVerification, VoiceUser } from "@stores/voice.store";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { attachStreamPreview, attachScrollCollapse } from "@lib/streamPreview";
import { showUserVolumeMenu } from "./channel-sidebar/volume-menu";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";
import { attachChannelContextMenu, CHANNEL_MUTE_CHANGED } from "./channel-sidebar/context-menu";
import { attachDragHandlers } from "./channel-sidebar/drag-reorder";
import { rePinPeerIdentity } from "@lib/livekitSession";
import { createIdentityMismatchModal } from "./IdentityMismatchModal";
import { createLogger } from "@lib/logger";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { roleHasPermission, canManageChannels, currentUserPermissions } from "@lib/permissions";
import { Permission } from "@lib/types";
import { importIdentityPublicKey, computeKeyFingerprint } from "@lib/e2eeCrypto";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";

const log = createLogger("ChannelSidebar");

/** Icon, color, and tooltip for a peer's E2EE identity verification badge
 *  (F3 TOFU). The states mirror the voice store's PeerVerification:
 *  a green shield-check when the announce signature verified against the pinned
 *  key, a muted shield when the peer published no key (legacy), a red
 *  shield-alert when the delivered key differs from the pinned one, and an
 *  amber shield-question when the local pin store could not be read (DC-08). */
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
          ? shellText("identity.verifiedWithNumber", { safetyNumber: v.safetyNumber })
          : shellText("identity.verified"),
    };
  }
  if (v.status === "mismatch") {
    return {
      icon: "shield-alert",
      color: "var(--red, #f23f43)",
      title: shellText("identity.mismatch"),
    };
  }
  if (v.status === "unknown") {
    return {
      icon: "shield-question",
      color: "var(--yellow, #f0b232)",
      title: shellText("identity.unknown"),
    };
  }
  // "unverified" — the remaining status: peer published no identity key (legacy).
  // No identity key means no safety number; the per-call session fingerprint
  // is the only value that can be compared out of band (OC-0003).
  return {
    icon: "shield",
    color: "var(--text-muted, #949ba4)",
    title:
      v.sessionFingerprint !== null
        ? shellText("identity.unverifiedWithFingerprint", { fingerprint: v.sessionFingerprint })
        : shellText("identity.unverified"),
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
  lifetimeSignal: AbortSignal,
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
  // The SIDEBAR (or a newer open) may have superseded us during the async
  // compute — but NOT a mere re-render: `lifetimeSignal` is the sidebar's own
  // factory-lifetime signal (aborted only in destroy()), not the per-render
  // one that renderChannels() replaces on every redraw (OC-0281). Binding this
  // check to the render signal made an unrelated re-render landing mid-compute
  // (a message in another channel, a peer toggling mute) turn the click into a
  // silent no-op.
  if (lifetimeSignal.aborted) return;
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
  // Close if the owning sidebar is destroyed while the modal is still open —
  // NOT on a re-render, which is why this is `lifetimeSignal` and not the
  // render-scoped signal (OC-0281).
  lifetimeSignal.addEventListener("abort", closeIdentityModal, { once: true });
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

/**
 * The marker on an age-restricted channel row.
 *
 * A glyph plus a title rather than a coloured name: the flag is information
 * about the channel, and recolouring the name would collide with the unread
 * and mention states the row already encodes that way.
 */
function nsfwIndicator(channelId: number): HTMLSpanElement {
  const badge = createElement("span", {
    class: "ch-nsfw",
    "data-testid": `channel-nsfw-${channelId}`,
    "aria-label": shellText("channel.ageRestricted"),
  });
  badge.title = shellText("channel.ageRestrictedTitle");
  badge.appendChild(createIcon("shield-alert", 13));
  return badge;
}

/**
 * "3/5" for a voice channel that has a user limit, or null when it is
 * unlimited (0) — a count with no ceiling is already shown by the participant
 * rows underneath, and "3/0" would read as a bug.
 *
 * Purely a readout: the server owns capacity and refuses a join over the limit
 * with CHANNEL_FULL. The client never blocks the click, because its copy of
 * the participant list can lag and a join it refused locally would be a
 * mistake nobody could correct.
 */
function voiceCapacityLabel(channel: Channel, connected: number): string | null {
  if (channel.voiceMaxUsers <= 0) return null;
  return `${connected}/${channel.voiceMaxUsers}`;
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

  const item = createElement("div", {
    class: classes,
    "data-testid": `channel-${channel.id}`,
    // Roving list item: reachable by Tab once, then arrow-stepped (B9-21).
    role: "link",
    tabindex: "-1",
  });
  item.dataset.channelId = String(channel.id);
  item.setAttribute("aria-current", isActive ? "page" : "false");

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

  // A muted channel still counts its unreads — it has not stopped existing,
  // it has stopped shouting — so the badge dims rather than disappearing. The
  // mention badge is deliberately left alone: a mute silences chatter, never
  // something addressed to the reader.
  const muted = isChannelMuted(channel.id);
  if (muted) {
    item.classList.add("muted");
  }

  // A mention badge outranks the plain unread badge: only one is shown, and
  // it counts the mentions, not the messages.
  if (channel.mentionCount > 0) {
    const badge = createElement(
      "span",
      { class: "mention-badge", "data-testid": `channel-mentions-${channel.id}` },
      String(channel.mentionCount),
    );
    badge.title = shellText("channel.mentions", { count: channel.mentionCount });
    item.appendChild(badge);
  } else if (channel.unreadCount > 0) {
    const badge = createElement(
      "span",
      { class: muted ? "unread-badge muted" : "unread-badge" },
      String(channel.unreadCount),
    );
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
function buildVoiceModOptions(
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
  lifetimeSignal: AbortSignal,
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
  // A timeout refuses a join (TIMED_OUT) but never a leave (B9-15, Q4).
  const timeout = isJoined ? null : safetyStore.getState().timeout;
  const timeoutReason =
    timeout === null ? null : safetyText("timeout.voice", { time: formatUntil(timeout.expiresAt) });
  const frozen = connectionStatus !== "connected" || timeoutReason !== null;
  let frozenReason = shellText(
    connectionStatus === "reconnecting" ? "channel.reconnecting" : "channel.notConnected",
  );
  if (connectionStatus === "connected" && timeoutReason !== null) frozenReason = timeoutReason;

  const wrapper = createElement("div", {});

  const classes = ["channel-item", "voice", isJoined ? "active" : "", frozen ? "disabled" : ""]
    .filter(Boolean)
    .join(" ");

  const item = createElement("div", {
    class: classes,
    "data-testid": `channel-${channel.id}`,
    // Roving list item: reachable by Tab once, then arrow-stepped (B9-21).
    role: "button",
    tabindex: "-1",
  });
  item.dataset.channelId = String(channel.id);
  if (frozen) {
    item.title = frozenReason;
    item.setAttribute("aria-disabled", "true");
  }

  const prefix = createElement("span", { class: "ch-icon", "aria-hidden": "true" });
  prefix.appendChild(createIcon("volume-2", 16));
  const name = createElement("span", { class: "ch-name" }, channel.name);

  appendChildren(item, prefix, name);

  if (channel.nsfw) {
    item.appendChild(nsfwIndicator(channel.id));
  }

  const voiceUsers = getChannelVoiceUsers(channel.id);
  const capacity = voiceCapacityLabel(channel, voiceUsers.length);
  if (capacity !== null) {
    const badge = createElement(
      "span",
      { class: "ch-capacity", "data-testid": `channel-capacity-${channel.id}` },
      capacity,
    );
    badge.title = shellText("channel.voiceCapacity", {
      connected: voiceUsers.length,
      max: channel.voiceMaxUsers,
    });
    item.appendChild(badge);
  }

  item.addEventListener(
    "click",
    () => {
      // Frozen while the WS socket is down or timed out — no-op; the reason is shown via title.
      if (uiStore.getState().connectionStatus !== "connected") return;
      if (!isJoined && safetyStore.getState().timeout !== null) return;
      if (isJoined) {
        onVoiceLeave();
      } else {
        onVoiceJoin(channel.id);
      }
    },
    { signal },
  );

  wrapper.appendChild(item);
  if (timeoutReason !== null) {
    wrapper.appendChild(
      createElement(
        "div",
        { class: "ch-restriction", "data-testid": `voice-timeout-${channel.id}` },
        timeoutReason,
      ),
    );
  }

  // Render connected voice users below the channel
  if (voiceUsers.length > 0) {
    const usersContainer = createElement("div", { class: "voice-users-list" });
    for (const user of voiceUsers) {
      const rowClasses = user.speaking ? "voice-user-item speaking" : "voice-user-item";
      const row = createElement("div", {
        class: rowClasses,
        "data-voice-uid": String(user.userId),
      });

      // Render the same identity a rename shows everywhere else (member list,
      // message rows, DM sidebar) — memberDisplayName prefers the nickname,
      // falling back to the username. Security-sensitive surfaces (the E2EE
      // mismatch modal, the moderation menu below) intentionally keep
      // rendering user.username instead, since a nickname is user-settable.
      const member = membersStore.getState().members.get(user.userId);
      const resolved = member !== undefined ? memberDisplayName(member) : user.username;

      const initial = resolved.length > 0 ? resolved.charAt(0).toUpperCase() : "?";
      const avatar = createElement("div", { class: "vu-avatar" }, initial);
      avatar.style.background = pickAvatarColor(resolved);
      row.appendChild(avatar);

      const label = resolved || shellText("common.unknown");
      const nameEl = createElement("span", { class: "vu-name" }, label);
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

        const liveBadge = createElement(
          "span",
          { class: "vu-live-badge" },
          shellText("channel.live"),
        );
        row.appendChild(liveBadge);
      }

      // A moderator-imposed mute/deafen gets its own class and tooltip: the
      // same mic-off glyph would otherwise read as an ordinary self-mute.
      if (user.deafened) {
        const muteIcon = createElement("span", {
          class: user.serverMuted === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverMuted === true) muteIcon.title = shellText("channel.mutedByModerator");
        muteIcon.appendChild(createIcon("mic-off", 14));
        const deafIcon = createElement("span", {
          class: user.serverDeafened === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverDeafened === true) deafIcon.title = shellText("channel.deafenedByModerator");
        deafIcon.appendChild(createIcon("headphones-off", 14));
        row.appendChild(muteIcon);
        row.appendChild(deafIcon);
      } else if (user.muted) {
        const muteIcon = createElement("span", {
          class: user.serverMuted === true ? "vu-muted vu-server-muted" : "vu-muted",
        });
        if (user.serverMuted === true) muteIcon.title = shellText("channel.mutedByModerator");
        muteIcon.appendChild(createIcon("mic-off", 14));
        row.appendChild(muteIcon);
      }

      // The local user's own session fingerprint (OC-0003): what a peer who
      // sees us as unverified compares against, so show it where it can be
      // read out. The local user is never in peerVerifications.
      const currentUser = getCurrentUser();
      const ownFingerprint = voiceStore.select((st) => st.localSessionFingerprint ?? null);
      if (currentUser !== null && currentUser.id === user.userId && ownFingerprint !== null) {
        const own = createElement("span", { class: "vu-verify vu-session-fp" });
        own.style.color = "var(--text-muted, #949ba4)";
        own.title = shellText("channel.ownSessionFingerprint", { fingerprint: ownFingerprint });
        own.appendChild(createIcon("shield", 14));
        row.appendChild(own);
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
              // lifetimeSignal (not the per-render `signal`): the modal must
              // survive an unrelated re-render, and must not be silently
              // skipped by one landing during the async fingerprint compute
              // (OC-0281). The click listener itself stays on the per-render
              // `signal` so it dies with this row (OC-0229).
              void openIdentityMismatchModal(
                user.userId,
                user.username || shellText("common.unknown"),
                lifetimeSignal,
              );
            },
            { signal },
          );
        }
        row.appendChild(badge);
      }

      // Right-click for per-user volume (skip for own user)
      if (currentUser === null || currentUser.id !== user.userId) {
        row.addEventListener(
          "contextmenu",
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            showUserVolumeMenu(
              user.userId,
              user.username || shellText("common.unknown"),
              e.clientX,
              e.clientY,
              // lifetimeSignal (not the per-render `signal`): the menu is
              // mounted on document.body, independent of this row's render,
              // and must not be torn down by an unrelated re-render (OC-0282).
              lifetimeSignal,
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
            // Watching a stream needs a live LiveKit room -- join first, same
            // as the hover/focus preview's placeholder click below.
            if (voiceStore.getState().currentChannelId !== channel.id) {
              onVoiceJoin(channel.id);
            }
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
          user.username || shellText("common.unknown"),
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
  lifetimeSignal: AbortSignal,
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
      lifetimeSignal,
      onVoiceJoin,
      onVoiceLeave,
      onWatchStream,
      onVoiceModerate,
    );
  } else {
    el = renderTextChannelItem(channel, isActive, signal);
  }
  attachChannelContextMenu(
    el,
    channel,
    signal,
    lifetimeSignal,
    onEditChannel,
    onDeleteChannel,
    onPurgeChannel,
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
 * A voice row is rebuilt on every render (`voiceTick`, below): it carries live
 * participant/stream/verification state whose changes already arrive through
 * this sidebar's voice and connection subscriptions, and those rows are few.
 * Text rows — the long list this milestone is about — keep their identity.
 * ponytail: voice rows intentionally stay unkeyed; key them too if a voice
 * roster ever grows large enough for the rebuild to matter.
 */
function channelRowSignature(
  channel: Channel,
  activeChannelId: number | null,
  orderIds: string,
  voiceTick: number,
): string {
  return [
    channel.id,
    channel.name,
    channel.type,
    channel.nsfw ? "n" : "",
    channel.voiceMaxUsers,
    activeChannelId === channel.id ? "a" : "",
    isChannelMuted(channel.id) ? "m" : "",
    channel.unreadCount,
    channel.mentionCount,
    orderIds,
    channel.type === "voice" ? voiceTick : "",
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
    onVoiceLeave,
    onCreateChannel,
    onEditChannel,
    onDeleteChannel,
    onReorderChannel,
    onWatchStream,
    onVoiceModerate,
    onPurgeChannel,
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
  let markAllBtn: HTMLButtonElement | null = null;

  const unsubscribers: Array<() => void> = [];

  /** Voice-user rows from the last render, keyed by user id — lets the
   *  speaking-only subscription patch classes without per-user querySelector. */
  const voiceRowByUserId = new Map<number, HTMLElement>();

  /**
   * Bumped by every refresh that can change a voice row's rendered state
   * (voice membership/streams/E2EE, connection status, timeout). Voice rows
   * fold it into their signature, so those refreshes rebuild them while text
   * rows stay keyed (B9-21).
   */
  let voiceTick = 0;

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

  /**
   * Listener owners for every keyed group and row. A reused element keeps its
   * owner; a replaced or removed one has its owner aborted before it detaches,
   * so a stale element can never outlive the render that replaced it (OC-0229)
   * — without aborting the listeners of every UNCHANGED row, which the old
   * single per-render controller did.
   */
  const ownerByEl = new WeakMap<Element, Disposable>();

  /** Abort a group's or row's owner and those of the rows inside it. */
  function disposeOwned(el: Element): void {
    for (const owned of [el, ...el.querySelectorAll(".category-channels-container > *")]) {
      ownerByEl.get(owned)?.destroy();
    }
  }

  /** `voiceChanged` is true for the refreshes that can alter a voice row's
   *  rendered state; they bump `voiceTick` so those rows rebuild. */
  function renderChannels(voiceChanged = false): void {
    updateMarkAllBtn();
    if (channelList === null) {
      return;
    }
    if (voiceChanged) voiceTick++;
    voiceRowByUserId.clear();

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
      const hint = createElement(
        "p",
        { class: "channel-list-empty-hint" },
        shellText("channel.emptyHint"),
      );
      appendChildren(emptyState, msg, hint);
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

    /** One group's rows, keyed and reused (B9-21). */
    function reconcileRows(container: HTMLElement, g: GroupRender): void {
      reconcileChildren(container, g.channels, {
        key: (ch) => String(ch.id),
        signature: (ch) => channelRowSignature(ch, activeChannelId, g.orderIds, voiceTick),
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
            onVoiceJoin,
            onVoiceLeave,
            onEditChannel,
            onDeleteChannel,
            container,
            g.channels,
            onReorderChannel,
            onWatchStream,
            onVoiceModerate,
            onPurgeChannel,
          );
          ownerByEl.set(el, owner);
          return el;
        },
        dispose: disposeOwned,
      });
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
    rebuildVoiceRowCache();
  }

  /** Build the header (and, when expanded, the rows) for one category group. */
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

      group.appendChild(header);
    }

    if (g.name === null || !isCategoryCollapsed(g.name)) {
      const container = createElement("div", { class: "category-channels-container" });
      // Populate through the reconciler so every row gets its key metadata; a
      // later in-place update can then recognise and reuse them.
      reconcileRows(container, g);
      group.appendChild(container);
    }

    return group;
  }

  /** Redraw when a row's mute is toggled (see CHANNEL_MUTE_CHANGED). */
  function handleMuteChanged(): void {
    renderChannels();
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });
    root.addEventListener(CHANNEL_MUTE_CHANGED, handleMuteChanged, { signal: disposable.signal });

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    const authState = authStore.getState();
    serverNameEl = createElement(
      "h2",
      {},
      authState.serverName ?? shellText("common.serverNameFallback"),
    );
    header.appendChild(serverNameEl);

    // Mark All as Read lives on the server header — it is a server-wide action,
    // and it only appears while something is actually unread so the header does
    // not carry a permanently dead button.
    markAllBtn = createElement("button", {
      class: "sidebar-mark-all-read",
      title: shellText("channel.markAllRead"),
      "aria-label": shellText("channel.markAllRead"),
      "data-testid": "mark-all-read",
    });
    markAllBtn.appendChild(createIcon("check", 16));
    markAllBtn.addEventListener(
      "click",
      (e: Event) => {
        e.stopPropagation();
        markAllRead();
      },
      { signal: disposable.signal },
    );
    header.appendChild(markAllBtn);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    // One Tab stop for the whole list; ArrowUp/Down step, Enter/Space open the
    // focused channel (B9-21). The listener lives on the list, which survives
    // every keyed re-render.
    enableRovingNavigation(channelList, ".channel-item", disposable.signal, "vertical");

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

    // Re-render voice rows when the WS connection status flips so the join/leave
    // affordance freezes/unfreezes with a visible reason (§3 connection status).
    const unsubConnStatus = uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      () => renderChannels(true),
    );
    unsubscribers.push(unsubConnStatus);
    unsubscribers.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
        () => renderChannels(true),
      ),
    );

    // Subscribe to voice store, split in two:
    //  (a) a structural selector (who is in which channel + mute/deafen/camera/
    //      screenshare + E2EE verification, excluding `speaking`) that does a
    //      full re-render;
    //  (b) a speaking-only patcher that toggles CSS classes on rows cached at
    //      render time, so a speaker event never destroys DOM elements (which
    //      kills hover) and never pays a per-user querySelector.
    const unsubVoiceStructure = voiceStore.subscribeSelector(
      (state) => {
        let structSig = `${state.currentChannelId ?? ""}#${state.localSessionFingerprint ?? ""}`;
        for (const [chId, users] of state.voiceUsers) {
          structSig += `|${chId}`;
          for (const [uid, u] of users) {
            // Include the E2EE verification status, safety number, and session
            // fingerprint so a verified↔unverified↔mismatch flip *and* a
            // same-status fingerprint/safety-number change (e.g. a reconnect that
            // re-announces a fresh ephemeral key, OC-0208) both re-render the
            // badge (it lives outside voiceUsers, in peerVerifications).
            const verif = state.peerVerifications?.get(uid);
            structSig += `:${uid}${u.muted ? "m" : ""}${u.deafened ? "d" : ""}${u.camera ? "c" : ""}${u.screenshare ? "s" : ""}${u.serverMuted === true ? "M" : ""}${u.serverDeafened === true ? "D" : ""}${verif ? `@${verif.status}/${verif.safetyNumber ?? ""}/${verif.sessionFingerprint ?? ""}` : ""}`;
          }
        }
        return structSig;
      },
      () => renderChannels(true),
    );
    unsubscribers.push(unsubVoiceStructure);

    // structSig above carries no identity field, so a rename (updateMemberProfile,
    // which bumps roleRevision on every USER_UPDATE) leaves the voice roster's
    // label stale until an unrelated structural event happens to re-render it
    // (OC-0333). Re-render on roleRevision to pick up the new name/nickname.
    const unsubMemberRevision = membersStore.subscribeSelector(
      (s) => s.roleRevision ?? 0,
      () => renderChannels(true),
    );
    unsubscribers.push(unsubMemberRevision);

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
    // disposable.destroy() also releases this sidebar's hold on the shared document-level
    // drag listeners (drag-reorder.ts tracks owners by signal).
    disposable.destroy();
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
