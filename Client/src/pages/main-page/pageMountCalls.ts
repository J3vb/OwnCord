/**
 * Main page mount steps for calls: ringing, the incoming and outgoing call UI,
 * the DM call panel, and the video grid's wiring to voice.
 */
import { desktop } from "../../platform/desktop";
import { showToast } from "@lib/ui/toast";
import { shellText } from "../../i18n/shell";
import {
  syncVideoGrid,
  syncGridCallState,
  type GridSyncDeps,
} from "../../features/voice/videoGridSync";
import { toastOutgoingCallOutcome } from "../../features/direct-messages/outgoingCallFeedback";
import { syncCallsWithVoice } from "../../features/direct-messages/callVoiceSync";
import { uiStore } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { watchGroupDmExits } from "../../features/direct-messages/groupExitWatch";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import {
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  getRemoteVideoStats,
  getLocalScreenshareStats,
  setRemoteVideoView,
  setRemoteVideoWatched,
  forgetRemoteVideoWatch,
} from "@lib/voice/livekitSession";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { createIncomingCallBanner } from "../../features/direct-messages/IncomingCallBanner";
import { createRingController, createOutgoingCall } from "@lib/voice/callRing";
import {
  startRingChime,
  stopRingChime,
  startRingback,
  stopRingback,
} from "@lib/media/notificationSound";
import { createTileMenuActions } from "./tileMenuActions";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { log, callAlerts, personName, getCurrentUserId, tileLabel } from "./pageShared";
import type { PageState, PageApi, MountScope } from "./pageState";

export function mountCalls(st: PageState, pg: PageApi, ms: MountScope): void {
  // --- DM calls ---
  // The banner is mounted on the page root rather than inside the chat area
  // so a ring stays visible while the user is looking at another channel —
  // which is exactly when a call most needs to be answerable.
  st.ringCtrl = createRingController({
    onRingStateChange: () => pg.syncRingSurfaces(),
    onChime: (playing) => (playing ? startRingChime() : stopRingChime()),
    onAccept: (channelId) => {
      createSidebarVoiceCallbacks(st.ws).onVoiceJoin(channelId);
    },
    onDecline: (channelId) => {
      st.ws.send({ type: "call_decline", payload: { channel_id: channelId } });
    },
    onRingStart: (ring) => void callAlerts().then((m) => m.alertIncomingCall(ring)),
    onMissed: (ring) => void callAlerts().then((m) => m.alertMissedCall(ring)),
    onRingEnd: (ring, reason) =>
      void callAlerts().then((m) => {
        m.clearIncomingCall(ring);
        if (reason === "superseded") m.alertSupersededCall(ring);
      }),
  });

  st.callBanner = createIncomingCallBanner({
    onAccept: (withVideo) => pg.acceptRing(withVideo),
    onDecline: () => st.ringCtrl?.decline(),
  });

  st.callBanner.mount(st.root!);

  st.children.push(st.callBanner);

  st.outgoingCall = createOutgoingCall({
    onChange: (state) => {
      st.callPanel?.setOutgoing(state);
      toastOutgoingCallOutcome(state);
    },
    onRingback: (playing) => (playing ? startRingback() : stopRingback()),
  });

  // Loaded on demand like the sidebar drawer: the panel is only drawn in a
  // DM with a call, so its code stays out of the eager MainPage chunk
  // (bundle budget). Until it lands, the banner answers every ring.
  void callAlerts().then(({ createDmCallPanel }) => {
    if (st.tornDown) return;
    const panel = createDmCallPanel({
      onMuteToggle: () => ms.voiceKeybindActions.onMuteToggle(),
      onDeafenToggle: () => ms.voiceKeybindActions.onDeafenToggle(),
      onCameraToggle: () => ms.voiceKeybindActions.onCameraToggle(),
      onScreenshareToggle: () => ms.voiceKeybindActions.onScreenshareToggle(),
      onLeave: () => ms.voiceKeybindActions.onDisconnect(),
      onAccept: (withVideo) => pg.acceptRing(withVideo),
      onDecline: () => st.ringCtrl?.decline(),
      onJoin: pg.joinDmCall,
      onRingAgain: (channelId) => {
        if (uiStore.getState().connectionStatus !== "connected") {
          showToast(shellText("channel.notConnected"), "error");
          return;
        }
        pg.ringCallees(channelId);
      },
      onVideoHostChange: () => st.videoModeCtrl?.checkVideoMode(),
      videoGrid: ms.chatAreaResult.videoGrid,
    });
    // Published before mount: mounting reports whether it can host video,
    // and the video controller reads the panel through callPanelHost.
    st.callPanel = panel;
    st.callPanelHost = {
      ownsCall: (channelId) => panel.ownsCall(channelId),
      element: () => panel.videoElement(),
      setActive: (active) => panel.setVideoActive(active),
    };
    panel.mount(ms.chatAreaResult.callPanelSlot);
    st.children.push(panel);
    panel.setOutgoing(st.outgoingCall?.current() ?? null);
    pg.syncRingSurfaces();
  });

  // The ring's surface depends on what is on screen.
  st.unsubscribers.push(
    channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => pg.syncRingSurfaces(),
    ),
    uiStore.subscribeSelector(
      (s) => s.activeView === null && !s.settingsOpen,
      () => pg.syncRingSurfaces(),
    ),
    // A queued ring must not outlive a drop, even one that reconnects before
    // the timer fires: voice has not rejoined yet, so it would ring an empty room.
    uiStore.subscribeSelector(
      (s) => s.connectionStatus !== "connected",
      (down) => {
        if (down) pg.cancelPendingRing();
      },
    ),
  );

  // The outgoing ring is over once anyone else is in the room, or once
  // the caller is not; an incoming ring is answered by being in its room,
  // however you got there; and "Join with video" turns the camera on as
  // soon as the accepted call is connected.
  st.unsubscribers.push(
    voiceStore.subscribe((state) => syncCallsWithVoice(state, st, getCurrentUserId)),
  );

  // Losing a group (left, or removed) ends its ring without a missed call:
  // the server stops sending that room's voice_leave, so the 30 s timeout
  // would otherwise report a call from a group the user is no longer in.
  // A leave the server then refuses restores the row but not the ring.
  st.unsubscribers.push(
    watchGroupDmExits((channelId) => {
      if (st.ringCtrl?.current()?.channelId === channelId) st.ringCtrl.cancel(channelId);
      if (st.outgoingCall?.current()?.channelId === channelId) st.outgoingCall.clear();
    }),
  );

  st.unsubscribers.push(
    st.ws.on("call_incoming", (payload) => {
      try {
        // Being in the room already answers the ring (a redial from
        // someone in the call re-rings everyone else in the DM).
        if (voiceStore.getState().currentChannelId === payload.channel_id) return;
        // A call in the DM you are already sitting in still rings: the
        // channel being open does not mean the app has focus, and Discord
        // rings there too.
        // Resolve through the members store, same as every other identity
        // surface (voice roster, member list, DM header) -- the raw wire
        // username is only a fallback for a caller this client hasn't
        // seen yet.
        const caller = membersStore.getState().members.get(payload.from_user);
        st.ringCtrl?.incoming({
          channelId: payload.channel_id,
          fromUserId: payload.from_user,
          fromUsername: caller !== undefined ? memberDisplayName(caller) : payload.username,
        });
      } catch (err) {
        log.error("call_incoming handler error", err);
      }
    }),
  );

  st.unsubscribers.push(
    st.ws.on("call_declined", (payload) => {
      // Addressed to every other DM participant, not just the caller — the
      // server holds no call state to target with (see handlers_call.go).
      // In a group DM that includes fellow callees who are also ringing;
      // only the actual ringer declining should silence this client's ring.
      // The caller hears about it too: in a 1:1 a decline ends the ring,
      // in a group it takes that callee off the list.
      st.outgoingCall?.declined(payload.channel_id, payload.from_user);
      const ringing = st.ringCtrl?.current();
      if (ringing === null || ringing === undefined) return;
      if (payload.from_user === ringing.fromUserId) {
        st.ringCtrl?.cancel(payload.channel_id);
      }
    }),
  );

  // Anyone leaving the ringing room: when it has emptied there is no call
  // left to answer, and no call record to close, so the voice_leave is the
  // only signal. Ringing for a room with nobody in it is worse than a
  // missed call, so a leave stops the ring for that channel — but only
  // when it actually emptied the room. A group DM can still hold other
  // callees who already accepted (voiceStore.voiceUsers answers that), and
  // the ringer hanging up must not silence a call that is still live for
  // them; the last one out, ringer or not, ends it.
  st.unsubscribers.push(
    st.ws.on("voice_leave", (payload) => {
      const ringing = st.ringCtrl?.current();
      if (ringing === null || ringing === undefined) return;
      if (payload.channel_id !== ringing.channelId) return;
      const roster = voiceStore.getState().voiceUsers.get(payload.channel_id);
      const othersStillIn =
        roster !== undefined && [...roster.keys()].some((id) => id !== payload.user_id);
      if (!othersStillIn) {
        st.ringCtrl?.cancel(payload.channel_id, "ringer-left");
      }
    }),
  );

  // The server answers a ring it refuses with an error frame carrying the
  // ring's envelope id, whatever the code (CALL_REQUIRES_ACCEPTANCE,
  // RATE_LIMITED, FORBIDDEN, TIMED_OUT, NOT_FOUND, VOICE_ERROR, INTERNAL):
  // nobody was rung, so end the caller's "Calling…" and ringback now. The
  // correlation id is the guard, not the code. The dispatcher shows the
  // server's explanation as the toast; the caller stays in the room.
  st.unsubscribers.push(
    st.ws.on("error", (_payload, id) => {
      if (id === st.lastRingId) st.outgoingCall?.clear();
    }),
  );

  st.unsubscribers.push(() => {
    st.ringCtrl?.destroy();
    st.ringCtrl = null;
    st.callBanner = null;
    st.callPanel = null;
    st.callPanelHost = null;
    st.outgoingCall?.destroy();
    st.outgoingCall = null;
    st.cameraOnJoin = null;
  });
}

export function mountVideo(st: PageState, pg: PageApi, ms: MountScope): void {
  // Wire remote video callbacks to video grid
  setOnRemoteVideo((userId, stream, isScreenshare) => {
    if (st.videoGrid === null) return;
    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    if (channelId === null) return;
    const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
    const username = tileLabel(userId, isScreenshare);
    const name = personName(userId);
    st.videoGrid.addStream(tileId, username, stream, {
      isSelf: false,
      audioUserId: userId,
      isScreenshare,
      ...(name === undefined || name === "" ? {} : { name }),
    });
    st.videoModeCtrl?.checkVideoMode();
  });

  setOnRemoteVideoRemoved((userId, isScreenshare) => {
    const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
    st.videoGrid?.removeStream(tileId);
    st.videoModeCtrl?.checkVideoMode();
  });

  st.unsubscribers.push(() => clearOnRemoteVideo());

  ms.tileMenu = createTileMenuActions(st.ws, ms.sidebar.messageUser, () =>
    st.videoModeCtrl?.showChat(),
  );

  st.unsubscribers.push(ms.tileMenu.destroy);

  // The cover on your own screen-share preview stops the share.
  ms.chatAreaResult.videoGrid.setCallbacks({
    onStopSharing: () => {
      if (voiceStore.getState().localScreenshare) ms.voiceKeybindActions.onScreenshareToggle();
    },
    // HTML full screen fills only the webview in WebView2: take the window
    // along (a no-op where the webview already filled it), or a stream
    // pop-out window by its label.
    setWindowFullscreen: (...args) => desktop.window.setFullscreen(...args),
    callControls: {
      onMuteToggle: () => ms.voiceKeybindActions.onMuteToggle(),
      onDeafenToggle: () => ms.voiceKeybindActions.onDeafenToggle(),
      onLeave: () => ms.voiceKeybindActions.onDisconnect(),
      onCameraToggle: () => ms.voiceKeybindActions.onCameraToggle(),
      onCameraDevice: (anchor, signal) =>
        void import("../../features/voice/cameraMenu")
          .then((m) => m.showCameraMenu(anchor, signal))
          .catch((err: unknown) => log.warn("Camera menu failed to open", err)),
      cameraFlip: {
        available: () =>
          import("../../features/voice/cameraFlip").then((m) => m.cameraFlipAvailable()),
        flip: () => import("../../features/voice/cameraFlip").then((m) => m.flipCamera()),
      },
      onScreenshareToggle: () => ms.voiceKeybindActions.onScreenshareToggle(),
    },
    getStreamStats: (tileId) =>
      tileId >= SCREENSHARE_TILE_ID_OFFSET
        ? getRemoteVideoStats(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare")
        : getRemoteVideoStats(tileId, "camera"),
    getLocalShareStats: () => getLocalScreenshareStats(),
    onStreamRemoved: () => st.videoModeCtrl?.checkVideoMode(),
    isStreamLive: (userId, screenshare) => {
      const { currentChannelId, voiceUsers } = voiceStore.getState();
      if (currentChannelId === null) return false;
      const user = voiceUsers.get(currentChannelId)?.get(userId);
      return (screenshare ? user?.screenshare : user?.camera) === true;
    },
    setStreamView: (tileId, view) =>
      tileId >= SCREENSHARE_TILE_ID_OFFSET
        ? setRemoteVideoView(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare", view)
        : setRemoteVideoView(tileId, "camera", view),
    setStreamWatched: (tileId, on) =>
      tileId >= SCREENSHARE_TILE_ID_OFFSET
        ? setRemoteVideoWatched(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare", on)
        : setRemoteVideoWatched(tileId, "camera", on),
    forgetStreamWatch: (tileId) =>
      tileId >= SCREENSHARE_TILE_ID_OFFSET
        ? forgetRemoteVideoWatch(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare")
        : forgetRemoteVideoWatch(tileId, "camera"),
    // The grid header's exit control: back to chat without leaving voice.
    onExitGrid: () => st.videoModeCtrl?.showChat(),
    onCallPopout: (out, restore) => st.videoModeCtrl?.setCallPoppedOut(out, restore),
    // The mini-player's way back to the full stream view.
    focusFallback: () => void ms.focusReachable(),
    onReturnToStream: (tileId) => {
      st.videoModeCtrl?.showVideoGrid();
      st.videoModeCtrl?.setFocus(tileId);
    },
    tileMenu: ms.tileMenu,
  });

  ms.prevVideoSignature = "";

  ms.prevSpeaking = "";

  ms.prevAudioState = "";

  ms.prevViewers = "";

  ms.prevCallState = "";

  ms.syncCallState = (state: VoiceState): void => syncGridCallState(state, ms, () => st.videoGrid);

  st.unsubscribers.push(
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      () => ms.syncCallState(voiceStore.getState()),
    ),
  );

  ms.prevTileLabels = new Map<number, string>();

  // A page rebuilt while already in voice (reconnect) loads the grid now.
  ms.gridLoadChannel = voiceStore.getState().currentChannelId;

  if (ms.gridLoadChannel !== null) ms.chatAreaResult.videoGrid.ensureLoaded();

  // Subscribe to voice store for camera/screenshare state changes, voice
  // channel switches, remote-tile identity changes and who is speaking.
  const gridSync: GridSyncDeps = {
    grid: () => st.videoGrid,
    ensureLoaded: () => ms.chatAreaResult.videoGrid.ensureLoaded(),
    checkVideoMode: () => st.videoModeCtrl?.checkVideoMode(),
    tileLabel,
    personName,
    syncCallState: (state) => ms.syncCallState(state),
  };
  st.unsubscribers.push(
    voiceStore.subscribe((state) => {
      try {
        syncVideoGrid(state, ms, gridSync);
      } catch (err) {
        log.error("Voice store subscription error", err);
      }
    }),
  );
}
