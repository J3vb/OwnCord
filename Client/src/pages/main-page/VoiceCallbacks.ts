/**
 * VoiceCallbacks — factory functions for voice widget and sidebar voice callbacks.
 * Stateless callback factories extracted from MainPage for testability.
 */

import { createLogger } from "@lib/logger";
import type { WsClient } from "@lib/ws";
import { voiceStore, joinVoiceChannel, leaveVoiceChannel } from "@stores/voice.store";
import { uiStore } from "@stores/ui.store";
import type { VoiceModerationCallbacks } from "@components/ChannelSidebar";
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
      // A moderator-imposed mute is not ours to lift; the server refuses the
      // unmute, so don't spend the round-trip (keybinds reach here too, not
      // just the disabled button).
      if (state.localServerMuted === true) return;
      if (state.localMuted) {
        voiceSessionSetMuted(false);
        ws.send({ type: "voice_mute", payload: { muted: false } });
        // A moderator-imposed deafen is not ours to lift; the server refuses
        // the undeafen, so don't spend the round-trip (same guard as
        // onDeafenToggle's localServerMuted check below).
        if (state.localDeafened && state.localServerDeafened !== true) {
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
      if (state.localServerDeafened === true) return;
      if (state.localDeafened) {
        voiceSessionSetDeafened(false);
        ws.send({ type: "voice_deafen", payload: { deafened: false } });
        // A moderator-imposed mute is not ours to lift; the server refuses
        // the unmute, so don't spend the round-trip (same guard as
        // onMuteToggle above).
        if (state.localServerMuted !== true) {
          voiceSessionSetMuted(false);
          ws.send({ type: "voice_mute", payload: { muted: false } });
        }
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

/** Moderator voice actions. Fire-and-forget sends: the server answers with a
 *  voice_state / voice_leave broadcast on success and an error frame on
 *  refusal, so there is no optimistic local state to roll back. */
export function createVoiceModerationCallbacks(ws: WsClient): VoiceModerationCallbacks {
  return {
    onServerMute: (channelId, userId, muted) => {
      if (!socketLive()) return;
      log.info("Server mute", { channelId, userId, muted });
      ws.send({
        type: "voice_mod_mute",
        payload: { channel_id: channelId, user_id: userId, muted },
      });
    },
    onServerDeafen: (channelId, userId, deafened) => {
      if (!socketLive()) return;
      log.info("Server deafen", { channelId, userId, deafened });
      ws.send({
        type: "voice_mod_deafen",
        payload: { channel_id: channelId, user_id: userId, deafened },
      });
    },
    onMove: (userId, toChannelId) => {
      if (!socketLive()) return;
      log.info("Move voice user", { userId, toChannelId });
      ws.send({ type: "voice_mod_move", payload: { user_id: userId, to_channel_id: toChannelId } });
    },
    onDisconnect: (userId) => {
      if (!socketLive()) return;
      log.info("Disconnect voice user", { userId });
      ws.send({ type: "voice_mod_kick", payload: { user_id: userId } });
    },
  };
}

export function createSidebarVoiceCallbacks(ws: WsClient): SidebarVoiceCallbacks {
  return {
    onVoiceJoin: (channelId: number) => {
      if (!socketLive()) return;
      // Already there: a same-channel re-join (e.g. a DM "Start a call"
      // redial while the caller is still in the call) buys nothing and the
      // server refuses it with ALREADY_JOINED, which the dispatcher's
      // catch-all turns into a user-facing error toast (OC-0289). Callers
      // that used to hand-check this (ChannelSidebar's item click / stream
      // watch) stay correct since the guard is idempotent with theirs.
      if (voiceStore.getState().currentChannelId === channelId) return;
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
