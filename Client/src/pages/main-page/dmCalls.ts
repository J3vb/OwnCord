/**
 * Starting, ringing and accepting DM calls from the main page.
 */
import { showToast } from "@lib/ui/toast";
import { accountText as account } from "../../i18n/account";
import { shellText } from "../../i18n/shell";
import { joinBackoffText } from "../../features/voice/joinBackoffText";
import { uiStore } from "@stores/ui.store";
import { getActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { enableCamera } from "@lib/voice/livekitSession";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { log, getCurrentUserId } from "./pageShared";
import type { PageState, PageApi } from "./pageState";

export function createDmCalls(st: PageState, _pg: PageApi) {
  /** Join a DM's live call: the call panel's Join strip and a call log row's Join button. */
  function joinDmCall(channelId: number): void {
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(shellText("channel.notConnected"), "error");
      return;
    }
    st.cameraOnJoin = null;
    createSidebarVoiceCallbacks(st.ws).onVoiceJoin(channelId);
  }

  /**
   * Start a call in the currently open DM: join its voice channel and ring the
   * other participants.
   *
   * Joining first is deliberate. A "call" is presence in the DM's voice
   * channel, so the ring is only truthful once the caller is actually there —
   * ringing first would offer an empty room to whoever accepts.
   */
  function startCall(withVideo = false): void {
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    // onVoiceJoin silently refuses to join when the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — without this check the ring
    // and "Calling…" toast fire anyway, promising a call nobody can hear.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(shellText("channel.notConnected"), "error");
      return;
    }
    st.cameraOnJoin = null;
    createSidebarVoiceCallbacks(st.ws).onVoiceJoin(active.id);
    if (withVideo) {
      const v = voiceStore.getState();
      if (v.currentChannelId === active.id && v.voiceStatus === "connected") {
        // Already in this call: the join was a no-op, so there is no
        // "connected" to wait for.
        if (!v.localCamera) {
          enableCamera().catch((err: unknown) => {
            log.error("Camera on call start failed", { error: String(err) });
          });
        }
      } else if (v.currentChannelId === active.id) {
        // The join started; the voiceStore subscriber turns the camera on once
        // connected. A refused join (backoff) leaves nothing armed.
        st.cameraOnJoin = active.id;
      }
    }
    ringAfterJoin(active.id);
  }

  /** The server allows one call_ring per user per 3s (Server/ws/handlers_call.go);
   *  a refused ring's error frame would also roll back a join still in flight.
   *  The extra 250ms covers transport jitter: lastRingAt is stamped before the
   *  async send, so two rings exactly 3s apart here can land under the window. */
  const RING_SPACING_MS = 3250;

  function cancelPendingRing(): void {
    if (st.ringTimer !== null) clearTimeout(st.ringTimer);
    st.ringTimer = null;
    st.ringJoinWatch?.();
    st.ringJoinWatch = null;
  }

  /** Ring once the caller is actually in the channel; send nothing when the
   *  join was refused or the caller left. */
  function ringAfterJoin(channelId: number): void {
    cancelPendingRing();
    const settle = (): boolean => {
      const v = voiceStore.getState();
      if (v.currentChannelId !== channelId) {
        cancelPendingRing();
        return true;
      }
      // "securing" is E2EE setup and room.connect(): not yet in the room.
      if (v.voiceStatus === "joining" || v.voiceStatus === "securing") return false;
      st.ringJoinWatch?.();
      st.ringJoinWatch = null;
      ringCallees(channelId, true);
      return true;
    };
    if (settle()) return;
    st.ringJoinWatch = voiceStore.subscribe(() => void settle());
  }

  /** Send a ring no sooner than the server's window allows, through one owned
   *  timer, and start (or restart) the caller's 30s window when it goes out.
   *  The panel is the caller's feedback: it shows "Calling…" from then on,
   *  unless the call is already answered (a redial from inside a live call). */
  function ringCallees(channelId: number, inCall = false): void {
    cancelPendingRing();
    const wasHere = voiceStore.getState().currentChannelId === channelId;
    const wait = st.lastRingAt + RING_SPACING_MS - Date.now();
    if (wait > 0) {
      st.ringTimer = setTimeout(() => {
        st.ringTimer = null;
        const v = voiceStore.getState();
        // A ring that follows a join, or a redial from inside the call, needs
        // the caller still in it; Ring again pressed outside a call stays
        // valid until the caller moves to another channel.
        const here = v.currentChannelId === channelId;
        if (here || (!inCall && !wasHere && v.currentChannelId === null)) sendRing(channelId);
      }, wait);
      return;
    }
    sendRing(channelId);
  }

  function sendRing(channelId: number): void {
    // An unplanned drop keeps the voice channel, so a ring queued before it
    // would otherwise show "Calling…" for 30s with nobody notified.
    if (uiStore.getState().connectionStatus !== "connected") return;
    st.lastRingAt = Date.now();
    st.lastRingId = st.ws.send({ type: "call_ring", payload: { channel_id: channelId } });
    const roster = voiceStore.getState().voiceUsers.get(channelId);
    const self = getCurrentUserId();
    // The ring above already went out to the whole DM (a group redial from inside
    // a live call too, 3B-8); with someone else in the room there is no
    // "Calling…" to show, and the voice subscription would clear it at once.
    if (roster !== undefined && [...roster.keys()].some((id) => id !== self)) return;
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    // The server drops rings to offline members, so waiting on them would
    // hold "Calling…" to the 30s timeout after every online callee declined.
    // Keep them when nobody is online: nothing else to wait on.
    const all = dm?.participants ?? [];
    const online = all.filter((p) => p.status !== "offline");
    st.outgoingCall?.start(
      channelId,
      (online.length > 0 ? online : all).map((p) => p.id),
      // A 1:1 callee shown offline is told at once. The ring above still
      // went out: an invisible contact shows offline but can answer.
      dm?.isGroup === false && online.length === 0,
    );
  }

  /**
   * Draw the incoming ring on exactly one surface. While the ringing DM is on
   * screen the call panel is the answer surface and the banner stays hidden,
   * so there are never two Accept buttons; everywhere else the banner is the
   * only way to answer.
   */
  function syncRingSurfaces(): void {
    const ring = st.ringCtrl?.current() ?? null;
    // setIncoming re-derives the panel from the live stores first, so the
    // check below never reads a panel one channel switch behind.
    st.callPanel?.setIncoming(ring);
    const ui = uiStore.getState();
    const panelAnswers =
      ring !== null &&
      st.callPanel?.showsRingFor(ring.channelId) === true &&
      ui.activeView === null &&
      !ui.settingsOpen;
    st.callBanner?.setRing(panelAnswers ? null : ring, panelAnswers);
  }

  /** Accept the ring from either surface. */
  function acceptRing(withVideo: boolean): void {
    // ringCtrl.accept() unconditionally consumes the ring (stopRinging)
    // before onVoiceJoin ever runs, and onVoiceJoin itself silently refuses
    // to join while the socket is down (VoiceCallbacks.ts's socketLive()
    // guard) — so accepting while reconnecting would otherwise discard the
    // ring for good with no join and no retry. Guarded here, the only caller
    // of accept(), so the ring survives for the user to accept again once
    // reconnected.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(account("voice.canAnswerWhileReconnecting"), "error");
      return;
    }
    const backoffText = joinBackoffText();
    if (backoffText !== null) {
      showToast(backoffText, "error");
      return;
    }
    const ring = st.ringCtrl?.current() ?? null;
    if (ring === null) return;
    st.cameraOnJoin = withVideo ? ring.channelId : null;
    st.ringCtrl?.accept();
  }

  return {
    joinDmCall,
    startCall,
    cancelPendingRing,
    ringAfterJoin,
    ringCallees,
    sendRing,
    syncRingSurfaces,
    acceptRing,
  };
}
