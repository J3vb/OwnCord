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

export function createVideoModeController(
  opts: VideoModeControllerOptions,
): VideoModeController {
  const { slots, videoGrid, getCurrentUserId } = opts;
  let videoMode = false;
  /** Track whether we've already added the local self-view tile. */
  let localTileAdded = false;
  let localScreenshareTileAdded = false;
  let focusedTileId: number | null = null;

  function showVideoGrid(): void {
    if (videoMode) return;
    videoMode = true;
    slots.messagesSlot.style.display = "none";
    slots.typingSlot.style.display = "none";
    slots.inputSlot.style.display = "none";
    slots.videoGridSlot.style.display = "block";
  }

  function showChat(): void {
    if (!videoMode) return;
    videoMode = false;
    focusedTileId = null;
    localTileAdded = false;
    localScreenshareTileAdded = false;
    slots.messagesSlot.style.display = "";
    slots.typingSlot.style.display = "";
    slots.inputSlot.style.display = "";
    slots.videoGridSlot.style.display = "none";
  }

  function checkVideoMode(): void {
    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    if (channelId === null) {
      if (videoMode) showChat();
      return;
    }
    const channelUsers = voice.voiceUsers.get(channelId);
    if (!channelUsers) {
      if (videoMode) showChat();
      return;
    }

    // Check if any camera or screenshare is active
    let anyVideoOn = voice.localCamera || voice.localScreenshare;
    if (!anyVideoOn) {
      for (const user of channelUsers.values()) {
        if (user.camera || user.screenshare) {
          anyVideoOn = true;
          break;
        }
      }
    }
    // Auto-close video grid when no streams remain
    if (!anyVideoOn && videoMode) {
      showChat();
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

    // Remove remote video tiles for users who turned off their camera or screenshare
    if (channelUsers) {
      for (const user of channelUsers.values()) {
        if (!user.camera && !user.screenshare && user.userId !== currentUserId) {
          videoGrid.removeStream(user.userId);
        }
      }
    }
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
    if (videoMode) showChat();
    focusedTileId = null;
    localTileAdded = false;
    localScreenshareTileAdded = false;
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
