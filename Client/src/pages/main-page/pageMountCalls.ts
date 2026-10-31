/**
 * Main page mount steps for calls: ringing, the incoming and outgoing call UI,
 * the DM call panel, and the video grid's wiring to voice.
 */
import { desktop } from "../../platform/desktop";
import type { CallState } from "@components/VideoGrid";
import { isConnecting } from "../../features/voice/voiceStatusText";
import { showToast } from "@lib/ui/toast";
import { dmCallText } from "../../i18n/dmCall";
import { shellText } from "../../i18n/shell";
import { shareBlockReason } from "../../features/voice/shareGate";
import { uiStore } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { watchGroupDmExits } from "../../features/direct-messages/groupExitWatch";
import { voiceStore, isSelfMuted, streamViewers, type VoiceState } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import {
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  enableCamera,
  getRemoteVideoStats,
  getLocalScreenshareStats,
  setRemoteVideoView,
  setRemoteVideoWatched,
  forgetRemoteVideoWatch,
} from "@lib/voice/livekitSession";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { createIncomingCallBanner } from "@components/IncomingCallBanner";
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
      // The panel is the caller's feedback only while their DM is on screen;
      // elsewhere the ringback and a toast are all they get.
      if (state !== null && state.phase !== "ringing") {
        const ui = uiStore.getState();
        const panelShows =
          ui.activeView === null &&
          !ui.settingsOpen &&
          channelsStore.getState().activeChannelId === state.channelId;
        if (!panelShows) {
          const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
          // The same name the call panel would show: a 1:1 DM resolves the
          // recipient through the members store (the nickname every other
          // identity surface uses), a group uses the DM's own name.
          let name = dm !== undefined ? dmDisplayName(dm) : "";
          if (dm !== undefined && !dm.isGroup) {
            const member = membersStore.getState().members.get(dm.recipient.id);
            name =
              (member !== undefined ? memberDisplayName(member) : "") ||
              (dm.recipient.displayName ?? "") ||
              dm.recipient.username ||
              name;
          }
          const text =
            state.phase === "declined"
              ? dmCallText("declinedStatus", { name })
              : state.phase === "offline"
                ? dmCallText("offline", { name })
                : dmCallText("noAnswerStatus");
          showToast(text, "info", 6000);
        }
      }
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
    voiceStore.subscribe((state) => {
      const ring = st.ringCtrl?.current() ?? null;
      if (ring !== null && state.currentChannelId === ring.channelId) {
        st.ringCtrl?.cancel(ring.channelId);
      }
      const out = st.outgoingCall?.current() ?? null;
      if (out !== null) {
        const roster = state.voiceUsers.get(out.channelId);
        const self = getCurrentUserId();
        const answered = roster !== undefined && [...roster.keys()].some((id) => id !== self);
        if (state.currentChannelId !== out.channelId || answered) st.outgoingCall?.clear();
      }
      if (st.cameraOnJoin !== null) {
        if (state.currentChannelId !== st.cameraOnJoin) {
          st.cameraOnJoin = null;
        } else if (state.voiceStatus === "connected") {
          st.cameraOnJoin = null;
          if (!state.localCamera) {
            enableCamera().catch((err: unknown) => {
              log.error("Camera on join failed", { error: String(err) });
            });
          }
        }
      }
    }),
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

  /** Your call state for the grid's call controls, from the voice store and
   *  the chat socket (camera and share freeze while it is down). */
  ms.syncCallState = (state: VoiceState): void => {
    const socket = uiStore.getState().connectionStatus;
    const shareBlock = shareBlockReason(state);
    const callState: CallState = {
      muted: isSelfMuted(state),
      deafened: state.localDeafened,
      listenOnly: state.listenOnly,
      camera: state.localCamera,
      screenshare: state.localScreenshare,
      connecting: isConnecting(state.voiceStatus),
      serverMuted: state.localServerMuted === true,
      serverDeafened: state.localServerDeafened === true,
      ...(socket === "connected" ? {} : { offline: socket }),
      ...(shareBlock === null ? {} : { shareBlock }),
    };
    const callKey = JSON.stringify(callState);
    if (callKey === ms.prevCallState) return;
    ms.prevCallState = callKey;
    st.videoGrid?.setCallState(callState);
  };

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
  st.unsubscribers.push(
    voiceStore.subscribe((state) => {
      try {
        const channelId = state.currentChannelId;
        // The grid's code loads on a join, so the import overlaps the
        // connect. Once per channel: a failed import retries on the next
        // join, not on every voice update (speaking changes fire often).
        if (channelId !== ms.gridLoadChannel) {
          ms.gridLoadChannel = channelId;
          if (channelId !== null) ms.chatAreaResult.videoGrid.ensureLoaded();
        }
        // Speaking rings on the video tiles: only when who is speaking
        // changes, not on every store update.
        const talking = new Set<number>();
        for (const u of channelId !== null
          ? (state.voiceUsers.get(channelId)?.values() ?? [])
          : []) {
          if (u.speaking && !u.muted) talking.add(u.userId);
        }
        const speakingKey = [...talking].join(",");
        if (speakingKey !== ms.prevSpeaking) {
          ms.prevSpeaking = speakingKey;
          st.videoGrid?.setSpeaking(talking);
        }
        // Mute/deafen badges on the camera tiles, from the same roster state.
        let audioKey = "";
        const audioState = new Map<number, { muted: boolean; deafened: boolean }>();
        for (const u of channelId !== null
          ? (state.voiceUsers.get(channelId)?.values() ?? [])
          : []) {
          if (u.muted || u.deafened) {
            audioState.set(u.userId, { muted: u.muted, deafened: u.deafened });
            audioKey += `${String(u.userId)}:${String(u.muted)}${String(u.deafened)};`;
          }
        }
        if (audioKey !== ms.prevAudioState) {
          ms.prevAudioState = audioKey;
          st.videoGrid?.setUserAudioState(audioState);
        }
        // Eye + count on each screen-share tile: the other members watching it.
        let viewersKey = "";
        const viewerNames = new Map<number, readonly string[]>();
        const roster = channelId !== null ? state.voiceUsers.get(channelId) : undefined;
        for (const u of roster?.values() ?? []) {
          if (!u.screenshare) continue;
          const names = streamViewers(u.userId, false, state).flatMap((id) => {
            const name = roster?.get(id)?.username;
            return name === undefined ? [] : [name];
          });
          if (names.length === 0) continue;
          viewerNames.set(u.userId, names);
          viewersKey += `${String(u.userId)}:${names.join("\u0000")};`;
        }
        if (viewersKey !== ms.prevViewers) {
          ms.prevViewers = viewersKey;
          st.videoGrid?.setStreamViewers(viewerNames);
        }
        ms.syncCallState(state);

        // Seed the signature with the channel id so ANY voice-channel
        // switch changes it, even one where the camera/screenshare flags
        // happen to be identical on both sides (e.g. both channels empty).
        // Without this, VideoModeController.checkVideoMode() — the only
        // writer of its own lastChannelId — never runs for that switch,
        // so lastChannelId is still the old channel the next time it runs
        // (e.g. right after setOnRemoteVideo adds a fresh remote tile),
        // and it clears the grid it was just given.
        let sig =
          `${String(channelId)}|` +
          (state.localCamera ? `c${String(state.localCameraRev ?? 0)}` : "") +
          (state.localScreenshare ? `s${String(state.localShareRev ?? 0)}` : "");
        if (channelId !== null) {
          const users = state.voiceUsers.get(channelId);
          if (users) {
            for (const [uid, u] of users) {
              // Everyone in the call: the call view draws an avatar tile each.
              sig += `:u${uid}`;
              if (u.camera) sig += `:c${uid}`;
              if (u.screenshare) sig += `:s${uid}`;
              // Relabel an already-open remote tile whose display name
              // changed (mid-call rename) — addStream only runs once per
              // tile, so nothing else keeps its label in sync.
              // setLabel() no-ops for a tile that isn't open yet.
              const name = personName(uid) || undefined;
              if (u.camera) {
                const label = tileLabel(uid, false);
                if (ms.prevTileLabels.get(uid) !== label) {
                  ms.prevTileLabels.set(uid, label);
                  st.videoGrid?.setLabel(uid, label, name);
                }
              }
              if (u.screenshare) {
                const tileId = uid + SCREENSHARE_TILE_ID_OFFSET;
                const label = tileLabel(uid, true);
                if (ms.prevTileLabels.get(tileId) !== label) {
                  ms.prevTileLabels.set(tileId, label);
                  st.videoGrid?.setLabel(tileId, label, name);
                }
              }
            }
          }
        }
        if (sig !== ms.prevVideoSignature) {
          ms.prevVideoSignature = sig;
          st.videoModeCtrl?.checkVideoMode();
        }
      } catch (err) {
        log.error("Voice store subscription error", err);
      }
    }),
  );
}
