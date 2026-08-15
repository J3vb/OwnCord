/**
 * VideoModeController — chat/video-grid toggle and camera tile management.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { voiceStore } from "@stores/voice.store";
import { getLocalCameraStream, getLocalScreenshareStream } from "@lib/livekitSession";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import type { VideoGridComponent } from "@components/VideoGrid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoModeSlots {
  readonly messagesSlot: HTMLDivElement;
  readonly typingSlot: HTMLDivElement;
  readonly inputSlot: HTMLDivElement;
  readonly videoGridSlot: HTMLDivElement;
}

export interface VideoModeControllerOptions {
  readonly slots: VideoModeSlots;
  readonly videoGrid: VideoGridComponent;
  readonly getCurrentUserId: () => number;
}

export interface VideoModeController {
  /** Re-evaluate whether video mode should be active based on voice store state. */
  checkVideoMode(): void;
  /** Force switch to chat mode. */
  showChat(): void;
  /** Force switch to video grid mode. */
  showVideoGrid(): void;
  /** Whether video grid is currently visible. */
  isVideoMode(): boolean;
  /** Set focus on a specific video tile (focus mode). */
  setFocus(tileId: number): void;
  /** Get the currently focused tile ID, or null if none. */
  getFocusedTileId(): number | null;
  /** Reset state on teardown. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVideoModeController(opts: VideoModeControllerOptions): VideoModeController {
  const { slots, videoGrid, getCurrentUserId } = opts;
  let videoMode = false;
  /** Track whether we've already added the local self-view tile. */
  let localTileAdded = false;
  let localScreenshareTileAdded = false;
  let focusedTileId: number | null = null;
  /** The channel currentChannelId was on the previous checkVideoMode() call.
   *  A voice channel switch (A -> B) moves currentChannelId directly from A
   *  to B without ever passing through null (joinVoiceChannel is
   *  optimistic), so clearStreams() must key off any change of channel id,
   *  not just the transition to null — otherwise remote tiles from the old
   *  channel persist as dead MediaStreams and keep hasStreams() true
   *  forever (OC-0012). */
  let lastChannelId: number | null = null;
  /** Set when the user explicitly dismisses the grid while local video is
   *  still on (switching to a text channel). Without this, checkVideoMode()
   *  re-opens the grid the moment any remote peer's camera/screenshare
   *  toggles, since that re-invokes checkVideoMode() and localVideoOn is
   *  still true. Cleared once local video actually goes off, or when the
   *  grid is opened again through any other path. */
  let userDismissedVideo = false;

  function showVideoGrid(): void {
    userDismissedVideo = false;
    if (videoMode) return;
    videoMode = true;
    slots.messagesSlot.style.display = "none";
    slots.typingSlot.style.display = "none";
    slots.inputSlot.style.display = "none";
    slots.videoGridSlot.style.display = "block";
  }

  /** Close the grid without recording a dismissal. Used by the paths that
   *  close it on the user's behalf (no streams left, left the channel,
   *  teardown) — only an explicit showChat() is a dismissal. */
  function closeVideoGrid(): void {
    if (!videoMode) return;
    videoMode = false;
    focusedTileId = null;
    // Clear the grid's own focus state too — otherwise it stays pinned to
    // whatever tile was focused and the next auto-open (B5-15) reopens
    // straight into a stale focus layout.
    videoGrid.setFocusedTile(null);
    localTileAdded = false;
    localScreenshareTileAdded = false;
    slots.messagesSlot.style.display = "";
    slots.typingSlot.style.display = "";
    slots.inputSlot.style.display = "";
    slots.videoGridSlot.style.display = "none";
  }

  function showChat(): void {
    // The user asked for chat (switching to a text channel) while still
    // broadcasting — remember it, or checkVideoMode() drags them back into
    // the grid the next time any peer toggles a camera (v048).
    const voice = voiceStore.getState();
    if (voice.localCamera || voice.localScreenshare) {
      userDismissedVideo = true;
    }
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
    // not fire on reconnect (B1-8, OC-0012).
    if (channelId !== lastChannelId) {
      if (lastChannelId !== null) {
        videoGrid.clearStreams();
      }
      lastChannelId = channelId;
    }
    if (channelId === null) {
      // Not a dismissal: leaving voice can clear currentChannelId before
      // localCamera/localScreenshare go false, and this early return skips
      // the reset below — showChat() here would strand userDismissedVideo
      // set and suppress auto-open for the next session.
      closeVideoGrid();
      return;
    }
    const channelUsers = voice.voiceUsers.get(channelId);
    if (!channelUsers) {
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
    // Auto-close video grid when no streams remain
    if (!anyVideoOn) {
      closeVideoGrid();
    }
    // BUG-105: Auto-open video grid only for LOCAL camera/screenshare.
    // Remote streams require manual click (Discord-style behavior).
    const localVideoOn = voice.localCamera || voice.localScreenshare;
    if (!localVideoOn) {
      // Nothing left to dismiss — the next camera/screenshare start should
      // auto-open the grid again.
      userDismissedVideo = false;
    } else if (!videoMode && !userDismissedVideo) {
      showVideoGrid();
    }

    // Manage local self-view tile — only add once, skip if already showing
    const currentUserId = getCurrentUserId();
    if (voice.localCamera) {
      if (!localTileAdded) {
        const localStream = getLocalCameraStream();
        if (localStream !== null) {
          const me = channelUsers.get(currentUserId);
          videoGrid.addStream(
            currentUserId,
            me?.username ? `${me.username} (You)` : "You",
            localStream,
            { isSelf: true, audioUserId: currentUserId, isScreenshare: false },
          );
          localTileAdded = true;
        }
      }
    } else {
      videoGrid.removeStream(currentUserId);
      localTileAdded = false;
    }

    // Manage local screenshare self-view tile
    const screenshareUserId = currentUserId + SCREENSHARE_TILE_ID_OFFSET;
    if (voice.localScreenshare) {
      if (!localScreenshareTileAdded) {
        const localStream = getLocalScreenshareStream();
        if (localStream !== null) {
          const me = channelUsers.get(currentUserId);
          videoGrid.addStream(
            screenshareUserId,
            me?.username ? `${me.username} (Screen)` : "Your Screen",
            localStream,
            { isSelf: true, audioUserId: currentUserId, isScreenshare: true },
          );
          localScreenshareTileAdded = true;
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

  function destroy(): void {
    closeVideoGrid();
    focusedTileId = null;
    localTileAdded = false;
    localScreenshareTileAdded = false;
    userDismissedVideo = false;
    lastChannelId = null;
  }

  return {
    checkVideoMode,
    showChat,
    showVideoGrid,
    isVideoMode: isVideoModeActive,
    setFocus,
    getFocusedTileId,
    destroy,
  };
}
