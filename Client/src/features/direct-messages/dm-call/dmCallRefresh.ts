/** The DM call panel's in-place updates: rings, badges, controls, status and the timer. */
import { createIcon, swapIcon } from "@lib/icons";
import { clearChildren, setText } from "@lib/dom";
import { isSelfMuted, voiceStore, type VoiceState } from "@stores/voice.store";
import { uiStore } from "@stores/ui.store";
import type { DmChannel } from "@stores/dm.store";
import { isConnecting, isPhoneCallHold } from "../../voice/voiceStatusText";
import { shareBlockReason } from "../../voice/shareGate";
import { voiceText as t } from "../../../i18n/voice";
import { dmCallText as d } from "../../../i18n/dmCall";
import { currentUserId, resolvePerson, voiceUser, type AvatarRef } from "../DmCallViewModel";
import { connectedStatus } from "./dmCallRender";
import type { DmCallState, DmCallApi } from "./dmCallState";
import { formatDuration } from "@lib/text/duration";

/** Why camera and share are inert now, if they are. */
interface MediaLock {
  readonly frozen: boolean;
  readonly reason: string;
  readonly connecting: boolean;
}

function drawBadge(ref: AvatarRef, muted: boolean, deafened: boolean): void {
  const badge = deafened ? "headphones-off" : muted ? "mic-off" : null;
  ref.badge.hidden = badge === null;
  if (badge === null || ref.badge.dataset.icon === badge) return;
  clearChildren(ref.badge);
  ref.badge.appendChild(createIcon(badge, 14));
  ref.badge.dataset.icon = badge;
  ref.badge.title = deafened ? d("deafened") : d("muted");
}

/** One tile's speaking ring and mute or deafen badge; returns whether a
 *  peer is speaking there. */
function refreshAvatar(
  userId: number,
  ref: AvatarRef,
  voice: VoiceState,
  channelId: number,
  me: number,
): boolean {
  const inCallHere = voice.currentChannelId === channelId;
  const u = voiceUser(voice, channelId, userId);
  const isSelf = userId === me;
  const muted = isSelf && inCallHere ? isSelfMuted(voice) : (u?.muted ?? false);
  const deafened = isSelf && inCallHere ? voice.localDeafened : (u?.deafened ?? false);
  const speaking = u?.speaking === true && !muted;
  ref.wrap.classList.toggle("dcp-avatar--speaking", speaking);
  drawBadge(ref, muted, deafened);
  return speaking && !isSelf;
}

/** Why the mic button cannot be used now, or null: a phone call's hold, a
 *  moderator's mute, a call joined without a microphone. */
function micLockTitle(voice: VoiceState): string | null {
  if (isPhoneCallHold(voice)) return t("widget.control.phoneCallHold");
  if (voice.localServerMuted === true) return t("widget.mutedByModerator");
  return voice.listenOnly ? t("widget.control.listenOnly") : null;
}

function refreshMute(btn: HTMLButtonElement, voice: VoiceState): void {
  const selfMuted = isSelfMuted(voice);
  const held = isPhoneCallHold(voice);
  const lock = micLockTitle(voice);
  btn.setAttribute("aria-pressed", String(selfMuted || held));
  swapIcon(btn, selfMuted || voice.listenOnly || held ? "mic-off" : "mic", 20);
  btn.disabled = lock !== null;
  btn.title = lock ?? t("widget.control.mute");
}

function refreshDeafen(btn: HTMLButtonElement, voice: VoiceState): void {
  btn.setAttribute("aria-pressed", String(voice.localDeafened));
  swapIcon(btn, voice.localDeafened ? "headphones-off" : "headphones", 20);
  btn.disabled = voice.localServerDeafened === true;
  btn.title =
    voice.localServerDeafened === true
      ? t("widget.deafenedByModerator")
      : t("widget.control.deafen");
}

function refreshCamera(btn: HTMLButtonElement, voice: VoiceState, lock: MediaLock): void {
  btn.setAttribute("aria-pressed", String(voice.localCamera));
  swapIcon(btn, voice.localCamera ? "camera-off" : "camera", 20);
  btn.disabled = lock.frozen || lock.connecting;
  btn.title = lock.reason || (lock.connecting ? t("status.joining") : t("widget.control.camera"));
}

function refreshShare(btn: HTMLButtonElement, voice: VoiceState, lock: MediaLock): void {
  btn.setAttribute("aria-pressed", String(voice.localScreenshare));
  swapIcon(btn, voice.localScreenshare ? "monitor-off" : "monitor", 20);
  const block = shareBlockReason(voice);
  btn.disabled = lock.frozen || lock.connecting || block !== null;
  btn.title = lock.reason || (lock.connecting ? t("status.joining") : (block ?? d("share")));
}

export function createDmCallRefresh(
  st: DmCallState,
  dc: DmCallApi,
): { refresh(): void; tick(): void } {
  /** Every tile's ring and badge and its identity shield; returns the first
   *  peer who is speaking, by name, or "". */
  function refreshAvatars(voice: VoiceState, dm: DmChannel, me: number): string {
    let speaker = "";
    for (const [userId, ref] of st.avatars) {
      const peerSpeaking = refreshAvatar(userId, ref, voice, dm.channelId, me);
      if (peerSpeaking && speaker === "") speaker = resolvePerson(userId, dm, voice, me).name;
      if (userId === me)
        dc.syncOwnShield(userId, ref, voice.currentChannelId === dm.channelId ? voice : null);
      else dc.syncVerify(userId, ref, voice, dm);
    }
    return speaker;
  }

  function refreshSpeaking(speaker: string): void {
    if (st.speakingEl === null) return;
    const text = speaker === "" ? "" : ` · ${d("speaking", { name: speaker })}`;
    if (st.speakingEl.textContent !== text) setText(st.speakingEl, text);
  }

  /** In-place updates that never rebuild: rings, badges, controls, status. */
  function refresh(): void {
    const view = st.view;
    if (view.kind === "none") return;
    const voice = voiceStore.getState();
    refreshSpeaking(refreshAvatars(voice, view.dm, currentUserId()));
    if (view.kind === "connected" && st.statusEl !== null) {
      setText(st.statusEl, connectedStatus(view, voice));
      st.statusEl.classList.toggle("dcp-status--warn", isPhoneCallHold(voice));
    }
    st.secured?.sync(voice.voiceStatus === "connected", voice.encryptionDegraded === true);
    refreshControls(voice);
    tick();
  }

  /** Controls: the widget's rules. Socket down freezes camera and share
   *  (Leave stays live; mute and deafen apply locally and are restated when
   *  the socket returns); a moderator mute is not ours to lift. */
  function refreshControls(voice: VoiceState): void {
    const frozen = uiStore.getState().connectionStatus !== "connected";
    const lock: MediaLock = {
      frozen,
      reason: frozen ? t("status.notConnected") : "",
      // No room to attach a camera or screen to until the join has connected.
      connecting: isConnecting(voice.voiceStatus),
    };
    const { mute, deafen, camera, share } = st.controls;
    if (mute !== null) refreshMute(mute, voice);
    if (deafen !== null) refreshDeafen(deafen, voice);
    if (camera !== null) refreshCamera(camera, voice, lock);
    if (share !== null) refreshShare(share, voice, lock);
  }

  function tick(): void {
    const text =
      st.answeredAt === null ? "00:00" : formatDuration(Date.now() - st.answeredAt, true);
    for (const el of st.timerEls) if (el.textContent !== text) setText(el, text);
  }

  return { refresh, tick };
}
