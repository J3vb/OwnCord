/**
 * VideoModeController — chat/video-grid toggle and camera tile management.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { voiceStore } from "@stores/voice.store";
import { getLocalCameraStream } from "@lib/voiceSession";
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

    // Check if any camera is active
    let anyCameraOn = voice.localCamera;
    if (!anyCameraOn) {
      for (const user of channelUsers.values()) {
        if (user.camera) {
          anyCameraOn = true;
          break;
        }
      }
    }
    if (anyCameraOn && !videoMode) {
      showVideoGrid();
    } else if (!anyCameraOn && videoMode) {
      showChat();
    }

    // Manage local self-view tile
    const currentUserId = getCurrentUserId();
    if (voice.localCamera) {
      const localStream = getLocalCameraStream();
      if (localStream !== null) {
        const me = channelUsers.get(currentUserId);
        videoGrid.addStream(
          currentUserId,
          me?.username ? `${me.username} (You)` : "You",
          localStream,
        );
      }
    } else {
      videoGrid.removeStream(currentUserId);
    }

    // Remove remote video tiles for users who turned off their camera
    if (channelUsers) {
      for (const user of channelUsers.values()) {
        if (!user.camera && user.userId !== currentUserId) {
          videoGrid.removeStream(user.userId);
        }
      }
    }
  }

  function isVideoModeActive(): boolean {
    return videoMode;
  }

  function destroy(): void {
    if (videoMode) showChat();
  }

  return {
    checkVideoMode,
    showChat,
    showVideoGrid,
    isVideoMode: isVideoModeActive,
    destroy,
  };
}
