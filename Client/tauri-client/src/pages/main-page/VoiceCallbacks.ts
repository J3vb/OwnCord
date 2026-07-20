/**
 * VoiceCallbacks — factory functions for voice widget and sidebar voice callbacks.
 * Stateless callback factories extracted from MainPage for testability.
 */

import { createLogger } from "@lib/logger";
import type { WsClient } from "@lib/ws";
import { voiceStore, joinVoiceChannel, leaveVoiceChannel } from "@stores/voice.store";
import { uiStore } from "@stores/ui.store";
import {
  leaveVoice as voiceSessionLeave,
  setMuted as voiceSessionSetMuted,
  setDeafened as voiceSessionSetDeafened,
  enableCamera,
  disableCamera,
  enableScreenshare,
  disableScreenshare,
} from "@lib/livekitSession";

const log = createLogger("voice-callbacks");

/** Voice join/leave send over the WS socket; refuse when it's not live so we
 *  never fire voice_join/voice_leave into a down socket. The VoiceWidget freezes
 *  its controls with a visible reason (docs/architecture/ux/README.md §3); this
 *  is the defensive backstop for the sidebar join/leave path. */
function socketLive(): boolean {
  return uiStore.getState().connectionStatus === "connected";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceLimiters {
  readonly voice: { tryConsume(): boolean };
  readonly voiceVideo: { tryConsume(): boolean };
}

export interface VoiceWidgetCallbacks {
  readonly onDisconnect: () => void;
  readonly onMuteToggle: () => void;
  readonly onDeafenToggle: () => void;
  readonly onCameraToggle: () => void;
  readonly onScreenshareToggle: () => void;
}

export interface SidebarVoiceCallbacks {
  readonly onVoiceJoin: (channelId: number) => void;
  readonly onVoiceLeave: () => void;
}

// ---------------------------------------------------------------------------
// Voice Widget Callbacks
// ---------------------------------------------------------------------------

export function createVoiceWidgetCallbacks(
  ws: WsClient,
  limiters: VoiceLimiters,
): VoiceWidgetCallbacks {
  return {
    onDisconnect: () => {
      if (voiceStore.getState().currentChannelId === null) return;
      if (!socketLive()) return;
      log.info("Leaving voice channel (widget disconnect)");
      voiceSessionLeave(false);
      leaveVoiceChannel();
      ws.send({ type: "voice_leave", payload: {} });
    },
    onMuteToggle: () => {
      if (!limiters.voice.tryConsume()) return;
      const state = voiceStore.getState();
      if (state.localMuted) {
        voiceSessionSetMuted(false);
        ws.send({ type: "voice_mute", payload: { muted: false } });
        if (state.localDeafened) {
          voiceSessionSetDeafened(false);
          ws.send({ type: "voice_deafen", payload: { deafened: false } });
        }
      } else {
        voiceSessionSetMuted(true);
        ws.send({ type: "voice_mute", payload: { muted: true } });
      }
    },
    onDeafenToggle: () => {
      if (!limiters.voice.tryConsume()) return;
      const state = voiceStore.getState();
      if (state.localDeafened) {
        voiceSessionSetDeafened(false);
        ws.send({ type: "voice_deafen", payload: { deafened: false } });
        voiceSessionSetMuted(false);
        ws.send({ type: "voice_mute", payload: { muted: false } });
      } else {
        voiceSessionSetDeafened(true);
        ws.send({ type: "voice_deafen", payload: { deafened: true } });
        if (!state.localMuted) {
          voiceSessionSetMuted(true);
          ws.send({ type: "voice_mute", payload: { muted: true } });
        }
      }
    },
    onCameraToggle: () => {
      if (!limiters.voiceVideo.tryConsume()) return;
      const next = !voiceStore.getState().localCamera;
      const handleCameraError = (err: unknown) => {
        log.error("Camera toggle failed", { error: String(err) });
      };
      if (next) {
        enableCamera().catch(handleCameraError);
      } else {
        disableCamera().catch(handleCameraError);
      }
    },
    onScreenshareToggle: () => {
      if (!limiters.voiceVideo.tryConsume()) return;
      const next = !voiceStore.getState().localScreenshare;
      const handleScreenshareError = (err: unknown) => {
        log.error("Screenshare toggle failed", { error: String(err) });
      };
      if (next) {
        enableScreenshare().catch(handleScreenshareError);
      } else {
        disableScreenshare().catch(handleScreenshareError);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sidebar Voice Callbacks
// ---------------------------------------------------------------------------

export function createSidebarVoiceCallbacks(ws: WsClient): SidebarVoiceCallbacks {
  return {
    onVoiceJoin: (channelId: number) => {
      if (!socketLive()) return;
      log.info("Joining voice channel", { channelId });
      joinVoiceChannel(channelId);
      ws.send({ type: "voice_join", payload: { channel_id: channelId } });
    },
    onVoiceLeave: () => {
      if (!socketLive()) return;
      log.info("Leaving voice channel");
      voiceSessionLeave(false);
      leaveVoiceChannel();
      ws.send({ type: "voice_leave", payload: {} });
    },
  };
}
