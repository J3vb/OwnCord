/**
 * VideoModeController — chat/video-grid toggle and camera tile management.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import {
  getLocalCameraStream,
  getLocalScreenshareStream,
  hasLocalScreenshareAudio,
} from "@lib/livekitSession";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import type { VideoGridComponent } from "@components/VideoGrid";
import { shellText } from "../../i18n/shell";
import { buildCallPeople, type CallAvatarCache } from "./callPeople";
import { createCallChatResize, type CallChatResize } from "../../features/voice/callChatResize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoModeSlots {
  readonly messagesSlot: HTMLDivElement;
  readonly typingSlot: HTMLDivElement;
  readonly inputSlot: HTMLDivElement;
  readonly videoGridSlot: HTMLDivElement;
}

/** The DM call panel, as a place to show video. While the open DM is the
 *  voice channel's own DM, its panel is the only video surface: the grid moves
 *  into it (chat stays visible) and never takes over the chat column. */
export interface VideoPanelHost {
  /** True while the open DM is this voice channel's DM. */
  ownsCall(channelId: number): boolean;
  /** Where the grid goes, or null while the panel cannot show it (collapsed). */
  element(): HTMLElement | null;
  /** Whether any video is on in the call, so the panel can make room for it. */
  setActive(active: boolean): void;
}

export interface VideoModeControllerOptions {
  readonly slots: VideoModeSlots;
  /** The chat column holding the slots; it takes the split-layout class. */
  readonly chatColumn: HTMLElement;
  readonly videoGrid: VideoGridComponent;
  readonly getCurrentUserId: () => number;
  /** The DM call panel, once it has loaded (it is a lazy chunk). */
  readonly panelHost?: () => VideoPanelHost | null;
  /** The grid opened or closed (or went to a pop-out): callChat re-reads it. */
  readonly onGridChange?: () => void;
}

export interface VideoModeController {
  /** Re-evaluate whether video mode should be active based on voice store state. */
  checkVideoMode(): void;
  /** Force switch to chat mode. `keepWatching` (going to a text channel)
   *  keeps the watched stream playing in the mini-player; without it (the
   *  grid's own Show chat control) the stream stops showing. */
  showChat(opts?: { keepWatching?: boolean }): void;
  /** Force switch to video grid mode. */
  showVideoGrid(): void;
  /** Open the call view: the grid with everyone in the call, which stays
   *  open with no video on until the user leaves or goes back to chat. */
  openCall(): void;
  /** Whether video grid is currently visible. */
  isVideoMode(): boolean;
  /** The grid is up in this window (open and not popped out). */
  isGridInWindow(): boolean;
  /** Set focus on a specific video tile (focus mode). */
  setFocus(tileId: number): void;
  /** Get the currently focused tile ID, or null if none. */
  getFocusedTileId(): number | null;
  /** The grid's call pop-out opened (`out`) or closed; `restore` brings the
   *  call view back into this window. */
  setCallPoppedOut(out: boolean, restore: boolean): void;
  /** Show the grid beside the chat (the active channel is the joined voice
   *  channel) instead of over it. Cleared by closing the grid or a pop-out. */
  setChatBeside(on: boolean): void;
  /** Reset state on teardown. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The split needs room for the 360px chat column and a usable grid. */
export const CALL_CHAT_STACK_BELOW_PX = 720;

export function createVideoModeController(opts: VideoModeControllerOptions): VideoModeController {
  const { slots, videoGrid, getCurrentUserId } = opts;
  let videoMode = false;
  /** Track whether we've already added the local self-view tile. */
  let localTileAdded = false;
  let localScreenshareTileAdded = false;
  /** The capture the self camera tile shows. */
  let localCameraTrackId: string | undefined;
  /** The capture the self screen-share tile shows. */
  let localShareTrackId: string | undefined;
  let focusedTileId: number | null = null;
  /** The channel currentChannelId was on the previous checkVideoMode() call.
   *  A voice channel switch (A -> B) moves currentChannelId directly from A
   *  to B without ever passing through null (joinVoiceChannel is
   *  optimistic), so clearStreams() must key off any change of channel id,
   *  not just the transition to null — otherwise remote tiles from the old
   *  channel persist as dead MediaStreams and keep hasStreams() true
   *  forever. */
  let lastChannelId: number | null = null;
  /** Where the grid slot lives in the chat column, to put it back after the
   *  DM call panel has hosted it. */
  let slotHome: { parent: Node; next: Node | null } | null = null;
  /** The panel last told that video is on, so it is told when it is off. */
  let activeHost: VideoPanelHost | null = null;
  /** The user opened the call view: the grid stays up without video. */
  let callOpen = false;
  /** The call view is in its own window: this one shows the chat while the
   *  grid stays in video mode there. */
  let poppedOut = false;
  /** This controller gave the grid its people (the DM call panel gives them
   *  while it hosts the grid), so it takes them back. */
  let peopleGiven = false;
  /** The grid shows beside the chat, not over it. */
  let chatBeside = false;
  /** Watches the chat column's width while the split shows. */
  let splitObserver: ResizeObserver | null = null;
  /** The handle between the grid and the chat, made the first time the split shows. */
  let chatResize: CallChatResize | null = null;
  const avatarCache: CallAvatarCache = new Map();

  function clearPeople(): void {
    if (peopleGiven) videoGrid.setPeople([]);
    peopleGiven = false;
    avatarCache.clear();
  }

  /** Move the grid into the panel (or keep it there). */
  function hostInPanel(el: HTMLElement): void {
    // The panel shows the stream itself: take it back from the mini-player.
    videoGrid.hideMiniPlayer();
    const slot = slots.videoGridSlot;
    if (slot.parentNode !== el) {
      if (slotHome === null && slot.parentNode !== null) {
        slotHome = { parent: slot.parentNode, next: slot.nextSibling };
      }
      el.appendChild(slot);
    }
    slot.style.display = "block";
  }

  /** Put the grid back in the chat column, hidden unless video mode shows it. */
  function returnFromPanel(): void {
    const slot = slots.videoGridSlot;
    if (slotHome !== null) {
      const { parent, next } = slotHome;
      slotHome = null;
      parent.insertBefore(slot, next !== null && next.parentNode === parent ? next : null);
    }
    if (!videoMode) slot.style.display = "none";
  }

  function tellHost(host: VideoPanelHost | null, active: boolean): void {
    if (activeHost !== null && activeHost !== host) activeHost.setActive(false);
    activeHost = active ? host : null;
    host?.setActive(active);
  }

  /** The chat column shows the grid or the chat. */
  function showSlots(grid: boolean): void {
    const chat = grid && !chatBeside ? "none" : "";
    opts.chatColumn.classList.toggle("chat-area--call-chat", grid && chatBeside);
    watchSplitWidth(grid && chatBeside);
    slots.messagesSlot.style.display = chat;
    slots.typingSlot.style.display = chat;
    slots.inputSlot.style.display = chat;
    slots.videoGridSlot.style.display = grid ? "block" : "none";
    opts.onGridChange?.();
  }

  /** A chat column too narrow for both (the side panels count, not only the
   *  window) stacks the chat under the grid. */
  function watchSplitWidth(on: boolean): void {
    if (!on) {
      splitObserver?.disconnect();
      splitObserver = null;
      chatResize?.detach();
      opts.chatColumn.classList.remove("chat-area--call-chat-stacked");
      return;
    }
    chatResize ??= createCallChatResize(opts.chatColumn);
    chatResize.attach();
    if (splitObserver !== null || typeof ResizeObserver === "undefined") return;
    splitObserver = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const width = entry.contentRect.width;
      opts.chatColumn.classList.toggle(
        "chat-area--call-chat-stacked",
        width < CALL_CHAT_STACK_BELOW_PX,
      );
      chatResize?.refit(width);
    });
    splitObserver.observe(opts.chatColumn);
  }

  function setChatBeside(on: boolean): void {
    if (chatBeside === on) return;
    chatBeside = on;
    if (videoMode && !poppedOut) showSlots(true);
  }

  function showVideoGrid(): void {
    // Popped out: the call is shown in its window.
    if (videoGrid.raiseCallPopout()) return;
    videoGrid.hideMiniPlayer();
    if (videoMode) return;
    videoMode = true;
    showSlots(true);
    videoGrid.setExitVisible(true);
    // Opened for a stream (Watch, back from the mini-player): everyone in
    // the call is drawn too, before the next roster change.
    const { currentChannelId, voiceUsers } = voiceStore.getState();
    if (currentChannelId === null) return;
    const users = voiceUsers.get(currentChannelId);
    // The DM call panel draws its own call's people.
    if (users !== undefined && opts.panelHost?.()?.ownsCall(currentChannelId) !== true) {
      givePeople(users);
    }
  }

  function givePeople(users: ReadonlyMap<number, VoiceUser>): void {
    videoGrid.setPeople(buildCallPeople(users.values(), avatarCache));
    peopleGiven = true;
  }

  /** Close the grid. Used by the paths that close it on the user's behalf
   *  (no streams left, left the channel, teardown) and by showChat(). */
  function closeVideoGrid(): void {
    if (!videoMode) return;
    videoMode = false;
    focusedTileId = null;
    // Clear the grid's own focus state too — otherwise it stays pinned to
    // whatever tile was focused and the next open reopens
    // straight into a stale focus layout.
    videoGrid.setFocusedTile(null);
    localTileAdded = false;
    localScreenshareTileAdded = false;
    showSlots(false);
    videoGrid.setExitVisible(false);
    clearPeople();
  }

  function showChat(how?: { keepWatching?: boolean }): void {
    // The chat is already here; the call stays in its own window.
    if (poppedOut) return;
    callOpen = false;
    // The stream being watched keeps playing in the mini-player (Discord's),
    // picked while the grid still knows which tile is focused.
    if (videoMode && how?.keepWatching === true) videoGrid.showMiniPlayer();
    closeVideoGrid();
  }

  function checkVideoMode(): void {
    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    // Clear stale remote tiles on ANY change of channel — a real leave
    // (channelId -> null) and a direct A -> B switch both need it, since
    // VoiceCallbacks.onVoiceJoin moves currentChannelId straight from the
    // old channel to the new one without ever passing through null.
    // currentChannelId stays unchanged across auto-reconnect, so this does
    // not fire on reconnect.
    if (channelId !== lastChannelId) {
      if (lastChannelId !== null) {
        videoGrid.clearStreams();
      }
      lastChannelId = channelId;
    }
    const host = opts.panelHost?.() ?? null;
    if (channelId === null) {
      callOpen = false;
      returnFromPanel();
      tellHost(host, false);
      closeVideoGrid();
      return;
    }
    // A reconnect's resync can drop our channel from the roster for a moment;
    // the call view stays open through it.
    const channelUsers =
      voice.voiceUsers.get(channelId) ?? (callOpen ? new Map<number, VoiceUser>() : undefined);
    if (!channelUsers) {
      returnFromPanel();
      tellHost(host, false);
      closeVideoGrid();
      return;
    }

    // Check if any camera or screenshare is active.
    // Check both voice store state AND whether the grid has tiles, because
    // LiveKit track delivery can race ahead of the WS voice_state update.
    let anyVideoOn = voice.localCamera || voice.localScreenshare;
    if (!anyVideoOn) {
      for (const user of channelUsers.values()) {
        if (user.camera || user.screenshare) {
          anyVideoOn = true;
          break;
        }
      }
    }
    if (!anyVideoOn) {
      anyVideoOn = videoGrid.hasStreams();
    }
    const panel = host !== null && host.ownsCall(channelId) ? host : null;
    if (panel !== null) {
      // The DM's own call: the panel shows every stream, remote ones too,
      // with the chat still in view. Collapsed, it shows none and the chat
      // is never covered.
      callOpen = false;
      // The panel gives the grid its own people.
      peopleGiven = false;
      closeVideoGrid();
      tellHost(panel, anyVideoOn);
      const el = anyVideoOn ? panel.element() : null;
      if (el !== null) hostInPanel(el);
      else returnFromPanel();
    } else {
      returnFromPanel();
      tellHost(host, false);
    }
    // Auto-close video grid when no streams remain, unless it is the call view
    if (!anyVideoOn && !callOpen) {
      closeVideoGrid();
    }
    // No video opens the grid on its own, your own camera or share included:
    // the chat you are reading stays. The call view shows them while open.

    if (videoMode) givePeople(channelUsers);

    // Manage local self-view tile — only add once, skip if already showing
    const currentUserId = getCurrentUserId();
    // Prefer the member's display name (same identity every other surface
    // shows for a rename — see ChannelSidebar.ts's voice roster) over the
    // frozen voice-roster username.
    const member = membersStore.getState().members.get(currentUserId);
    const me = channelUsers.get(currentUserId);
    const myName = (member !== undefined ? memberDisplayName(member) : "") || me?.username;
    if (voice.localCamera) {
      // A camera switch puts a new capture under the same publication: draw
      // the tile again so it shows the live track, not the stopped one.
      if (
        localTileAdded &&
        getLocalCameraStream()?.getVideoTracks()[0]?.id !== localCameraTrackId
      ) {
        videoGrid.removeStream(currentUserId);
        localTileAdded = false;
      }
      if (!localTileAdded) {
        const localStream = getLocalCameraStream();
        if (localStream !== null) {
          videoGrid.addStream(
            currentUserId,
            myName ? shellText("tile.nameYou", { name: myName }) : shellText("tile.you"),
            localStream,
            {
              isSelf: true,
              audioUserId: currentUserId,
              isScreenshare: false,
            },
          );
          localTileAdded = true;
          localCameraTrackId = localStream.getVideoTracks()[0]?.id;
        }
      }
    } else {
      videoGrid.removeStream(currentUserId);
      localTileAdded = false;
    }

    // Manage local screenshare self-view tile
    const screenshareUserId = currentUserId + SCREENSHARE_TILE_ID_OFFSET;
    if (voice.localScreenshare) {
      // A changed source is a new capture: draw the tile again.
      if (
        localScreenshareTileAdded &&
        getLocalScreenshareStream()?.getVideoTracks()[0]?.id !== localShareTrackId
      ) {
        videoGrid.removeStream(screenshareUserId);
        localScreenshareTileAdded = false;
      }
      if (!localScreenshareTileAdded) {
        const localStream = getLocalScreenshareStream();
        if (localStream !== null) {
          videoGrid.addStream(
            screenshareUserId,
            myName ? shellText("tile.nameScreen", { name: myName }) : shellText("tile.yourScreen"),
            localStream,
            {
              isSelf: true,
              audioUserId: currentUserId,
              isScreenshare: true,
              hasAudio: hasLocalScreenshareAudio(),
            },
          );
          localScreenshareTileAdded = true;
          localShareTrackId = localStream.getVideoTracks()[0]?.id;
        }
      }
    } else {
      videoGrid.removeStream(screenshareUserId);
      localScreenshareTileAdded = false;
    }

    // Remote video tiles are managed exclusively by the onRemoteVideo /
    // onRemoteVideoRemoved callbacks (driven by LiveKit TrackSubscribed /
    // TrackUnsubscribed). Do NOT remove remote tiles here based on voice
    // store state — the WS voice_state update can lag behind LiveKit track
    // delivery, causing tiles to be removed immediately after being added.
  }

  function isVideoModeActive(): boolean {
    return videoMode;
  }

  function setFocus(tileId: number): void {
    focusedTileId = tileId;
    videoGrid.setFocusedTile(tileId);
  }

  function getFocusedTileId(): number | null {
    return focusedTileId;
  }

  function setCallPoppedOut(out: boolean, restore: boolean): void {
    poppedOut = out;
    if (!videoMode) return;
    // A popped-out call stays up without video, as an opened call view does.
    if (out) callOpen = true;
    if (out || restore) showSlots(!out);
  }

  function openCall(): void {
    callOpen = true;
    showVideoGrid();
    checkVideoMode();
  }

  function destroy(): void {
    callOpen = false;
    returnFromPanel();
    tellHost(null, false);
    closeVideoGrid();
    clearPeople();
    focusedTileId = null;
    localTileAdded = false;
    localScreenshareTileAdded = false;
    lastChannelId = null;
    chatResize?.destroy();
    chatResize = null;
  }

  return {
    checkVideoMode,
    showChat,
    showVideoGrid,
    openCall,
    isVideoMode: isVideoModeActive,
    isGridInWindow: () => videoMode && !poppedOut,
    setFocus,
    getFocusedTileId,
    setCallPoppedOut,
    setChatBeside,
    destroy,
  };
}
