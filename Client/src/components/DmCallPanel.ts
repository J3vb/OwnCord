/**
 * DmCallPanel — the call surface inside a DM, between the chat header and the
 * messages (Discord's DM call panel).
 *
 * A DM call is presence in the DM's voice channel, so the panel is a view over
 * data that already exists: the voice roster, the incoming ring
 * (`RingController`) and the caller's own outgoing ring (`OutgoingCall`). It
 * shows only while the open channel is a DM and one of those says a call is
 * happening, ringing or just rang out; `deriveCallView` is that decision.
 *
 * The in-call controls are the voice widget's own callbacks, so both surfaces
 * share the rate limiters and the moderator guards, and both read status from
 * the same store: they can never disagree. The bottom-left widget stays as the
 * way back to the call from anywhere else.
 *
 * The DOM is rebuilt only when the panel's structure changes (state, who is in
 * the room and their names and avatars, collapsed); speaking rings, mute badges, control states and the
 * timer update in place, so a speaking tick never re-fetches an avatar or drops
 * keyboard focus.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { loadPref, savePref } from "@lib/prefs/preferences";
import type { MountableComponent } from "@lib/text/safeRender";
import type { RingState, OutgoingCallState } from "@lib/voice/callRing";
import { voiceStore, isSelfMuted } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { uiStore } from "@stores/ui.store";
import { isConnecting, formatElapsed } from "@components/voiceStatusText";
import type { VideoGridComponent } from "@components/VideoGrid";
import { voiceText as t } from "../i18n/voice";
import { dmCallText as d } from "../i18n/dmCall";
import { shareBlockReason } from "../features/voice/shareGate";
import {
  type AvatarRef,
  callName,
  currentUserId,
  deriveCallView,
  type DmCallView,
  resolvePerson,
  swapIcon,
  voiceUser,
} from "./DmCallViewModel";
import { HEIGHT_PREF, MIN_HEIGHT, MESSAGES_MIN_HEIGHT, KEY_STEP } from "./dm-call/dmCallShared";
import type { DmCallState, DmCallApi } from "./dm-call/dmCallState";
import { connectedStatus, createDmCallRender } from "./dm-call/dmCallRender";
import { createDmCallVerify, identitiesOf } from "./dm-call/dmCallVerify";

export { absentMembers, deriveCallView } from "./DmCallViewModel";
export type { DmCallView, DmCallViewInput } from "./DmCallViewModel";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DmCallPanelOptions {
  readonly onMuteToggle: () => void;
  readonly onDeafenToggle: () => void;
  readonly onCameraToggle: () => void;
  readonly onScreenshareToggle: () => void;
  readonly onLeave: () => void;
  /** Answer the ring for this DM, optionally turning the camera on once in. */
  readonly onAccept: (withVideo: boolean) => void;
  readonly onDecline: () => void;
  /** Join (or switch to) the DM's call. */
  readonly onJoin: (channelId: number) => void;
  readonly onRingAgain: (channelId: number) => void;
  /** Whether the panel can host the call's video changed (it opened, closed,
   *  collapsed or expanded): the owner re-seats the grid. */
  readonly onVideoHostChange?: () => void;
  /** The shared video grid, which draws the panel's avatar tiles. */
  readonly videoGrid?: Pick<VideoGridComponent, "setPeople">;
}

export interface DmCallPanelComponent extends MountableComponent {
  readonly setIncoming: (ring: RingState | null) => void;
  readonly setOutgoing: (state: OutgoingCallState | null) => void;
  /** Whether the panel is showing the ring for this channel right now. */
  readonly showsRingFor: (channelId: number) => boolean;
  /** True while this panel shows the call in this voice channel. */
  readonly ownsCall: (channelId: number) => boolean;
  /** Where the call's video grid goes, or null while it cannot show one. */
  readonly videoElement: () => HTMLElement | null;
  /** Any video is on in the call: make room for the grid. */
  readonly setVideoActive: (active: boolean) => void;
}

// The OS call notification, urgent attention request and missed-call
// notice. Re-exported here so they ride in this panel's lazy chunk (the page
// imports the panel at mount) instead of a second dynamic chunk in MainPage,
// which would push its bundle budget over.
export {
  alertIncomingCall,
  alertMissedCall,
  alertSupersededCall,
  clearIncomingCall,
} from "../features/direct-messages/callAlerts";

export function createDmCallPanel(options: DmCallPanelOptions): DmCallPanelComponent {
  const disposable = new Disposable();
  const st: DmCallState = {
    options,
    disposable,
    unsubs: [],
    incoming: null,
    outgoing: null,
    collapsed: false,
    view: { kind: "none" },
    structureKey: "",
    videoActive: false,
    people: [],
    peopleGiven: false,
    videoEl: createElement("div", { class: "dcp-video", "data-testid": "dcp-video" }),
    hostSignature: "",
    destroyed: false,
    root: createElement("section", {
      class: "dm-call-panel",
      "data-testid": "dm-call-panel",
      tabindex: "-1",
    }),
    body: createElement("div", { class: "dcp-body" }),
    live: createElement("div", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
      "data-testid": "dm-call-live",
    }),
    resizer: createElement("div", {
      class: "dcp-resize",
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": d("resizeLabel"),
      "aria-valuemin": String(MIN_HEIGHT),
      tabindex: "0",
      "data-testid": "dcp-resize",
    }),
    savedHeight: loadPref<number>(HEIGHT_PREF, 0),
    drag: null,
    avatars: new Map<number, AvatarRef>(),
    controls: { mute: null, deafen: null, camera: null, share: null },
    statusEl: null,
    securedEl: null,
    timerEls: [],
    speakingEl: null,
    timerInterval: null,
    peerRoom: null,
    answeredAt: null,
    resizeOpts: { signal: disposable.signal },
    focusedShield: null,
  };
  const dc = {} as DmCallApi;
  Object.assign(dc, createDmCallRender(st, dc), createDmCallVerify(st, dc), { update });

  st.root.hidden = true;

  appendChildren(st.root, st.body, st.resizer, st.live);

  function computeView(): DmCallView {
    const voice = voiceStore.getState();
    const room = voice.currentChannelId;
    if (room !== st.peerRoom) {
      st.peerRoom = null;
      st.answeredAt = null;
    }
    const roster = room === null ? undefined : voice.voiceUsers.get(room);
    if (
      room !== null &&
      roster !== undefined &&
      [...roster.keys()].some((id) => id !== currentUserId())
    ) {
      if (st.peerRoom === null) st.answeredAt = Date.now();
      st.peerRoom = room;
    }
    return deriveCallView({
      activeChannelId: channelsStore.getState().activeChannelId,
      dms: dmStore.getState().channels,
      voice,
      selfId: currentUserId(),
      incoming: st.incoming,
      outgoing: st.outgoing,
      peerWasHere: st.peerRoom !== null,
    });
  }

  function keyOf(v: DmCallView): string {
    switch (v.kind) {
      case "incoming":
        return `incoming|${v.dm.channelId}|${v.ring.fromUserId}|${v.ring.fromUsername}`;
      case "live":
        return `live|${v.dm.channelId}|${v.inRoom.join(",")}|${String(v.otherChannelId)}`;
      case "outgoing":
        return `outgoing|${v.dm.channelId}|${v.pending.join(",")}|${String(st.collapsed)}|${String(st.videoActive)}`;
      case "unanswered":
        return `unanswered|${v.dm.channelId}|${v.reason}|${String(st.videoActive)}`;
      case "connected":
        return `connected|${v.dm.channelId}|${v.inRoom.join(",")}|${String(v.peerLeft)}|${String(v.canRingAgain)}|${String(st.collapsed)}|${String(st.videoActive)}`;
      default:
        return "none";
    }
  }

  // --- Resize -------------------------------------------------------------

  /** Only the expanded panel resizes; collapsed and strip rows keep their own
   *  height. The stylesheet clamps the height to the chat column. */
  function applyHeight(): void {
    const expanded = st.root.classList.contains("dm-call-panel--expanded");
    st.resizer.hidden = !expanded;
    if (!expanded) {
      endDrag();
      st.root.style.removeProperty("--dcp-height");
      return;
    }
    if (st.savedHeight > 0)
      st.root.style.setProperty("--dcp-height", `${String(st.savedHeight)}px`);
    else st.root.style.removeProperty("--dcp-height");
    st.resizer.setAttribute("aria-valuemax", String(maxHeight()));
    st.resizer.setAttribute("aria-valuenow", String(drawnHeight()));
  }

  function drawnHeight(): number {
    return Math.round(st.root.getBoundingClientRect().height);
  }

  /** The tallest the panel may be: the chat column less its fixed rows (the
   *  header, typing line and composer, at their current heights) and room for
   *  a few messages. */
  function maxHeight(): number {
    let column = st.root.parentElement;
    while (column !== null && getComputedStyle(column).display === "contents") {
      column = column.parentElement;
    }
    if (column === null) return MIN_HEIGHT;
    let fixed = 0;
    for (const child of Array.from(column.children)) {
      if (child.contains(st.root) || parseFloat(getComputedStyle(child).flexGrow) > 0) continue;
      fixed += child.getBoundingClientRect().height;
    }
    const available = column.getBoundingClientRect().height - fixed - MESSAGES_MIN_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.round(available));
  }

  /** Saves what is actually drawn: an audio-only panel never goes below its
   *  content (min-height: fit-content), so the saved height cannot sit under it. */
  function setHeight(height: number, max: number): void {
    st.savedHeight = Math.round(Math.max(MIN_HEIGHT, Math.min(height, max)));
    applyHeight();
    const drawn = drawnHeight();
    if (drawn > 0 && drawn !== st.savedHeight) {
      st.savedHeight = drawn;
      applyHeight();
    }
  }

  function endDrag(): void {
    if (st.drag === null) return;
    st.drag = null;
    st.root.classList.remove("dm-call-panel--resizing");
    savePref(HEIGHT_PREF, st.savedHeight);
  }

  st.resizer.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      st.drag = {
        startY: e.clientY,
        startHeight: st.root.getBoundingClientRect().height,
        max: maxHeight(),
      };
      st.root.classList.add("dm-call-panel--resizing");
      try {
        st.resizer.setPointerCapture(e.pointerId);
      } catch {
        // No capture (the pointer is already gone): moves over the handle still resize.
      }
    },
    st.resizeOpts,
  );

  st.resizer.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (st.drag !== null)
        setHeight(st.drag.startHeight + e.clientY - st.drag.startY, st.drag.max);
    },
    st.resizeOpts,
  );

  st.resizer.addEventListener("pointerup", endDrag, st.resizeOpts);

  st.resizer.addEventListener("pointercancel", endDrag, st.resizeOpts);

  st.resizer.addEventListener("lostpointercapture", endDrag, st.resizeOpts);

  st.resizer.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = e.key === "ArrowUp" ? -KEY_STEP : KEY_STEP;
      setHeight(st.root.getBoundingClientRect().height + step, maxHeight());
      savePref(HEIGHT_PREF, st.savedHeight);
    },
    st.resizeOpts,
  );

  // Double-click puts the default height back.
  st.resizer.addEventListener(
    "dblclick",
    () => {
      st.savedHeight = 0;
      applyHeight();
      savePref(HEIGHT_PREF, 0);
    },
    st.resizeOpts,
  );

  // --- Update ---------------------------------------------------------------

  function rebuild(): void {
    // Keep keyboard focus on the same control across a rebuild (a mute click
    // must not drop focus to <body>); fall back to the region itself.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && st.root.contains(active);
    const focusId = hadFocus ? (active.dataset.testid ?? "") : "";

    for (const child of Array.from(st.body.childNodes)) if (child !== st.videoEl) child.remove();
    for (const ref of st.avatars.values()) ref.verify?.remove();
    st.focusedShield = null;
    st.avatars = new Map();
    st.people = [];
    st.controls = { mute: null, deafen: null, camera: null, share: null };
    st.statusEl = null;
    st.securedEl = null;
    st.speakingEl = null;
    st.timerEls = [];
    st.root.classList.remove(
      "dm-call-panel--expanded",
      "dm-call-panel--collapsed",
      "dm-call-panel--strip",
      "dm-call-panel--video",
    );

    switch (st.view.kind) {
      case "none":
        break;
      case "incoming":
        dc.renderIncoming(st.view);
        break;
      case "live":
        dc.renderLive(st.view);
        break;
      case "outgoing":
        dc.renderOutgoing(st.view);
        break;
      case "unanswered":
        dc.renderUnanswered(st.view);
        break;
      case "connected":
        dc.renderConnected(st.view);
        break;
    }
    if (!st.root.classList.contains("dm-call-panel--video")) st.videoEl.remove();
    if (st.people.length > 0 || st.peopleGiven) {
      st.options.videoGrid?.setPeople(st.people);
      st.peopleGiven = st.people.length > 0;
    }
    st.root.hidden = st.view.kind === "none";
    // After the reveal, so the separator's value is measured from a drawn panel.
    applyHeight();
    if (st.view.kind === "none") st.root.removeAttribute("aria-label");
    else
      st.root.setAttribute(
        "aria-label",
        d("region", { name: callName(st.view.dm, currentUserId()) }),
      );
    st.root.dataset.state = st.view.kind;

    if (hadFocus) {
      const same =
        active.isConnected && st.videoEl.contains(active)
          ? active
          : focusId === ""
            ? null
            : st.body.querySelector<HTMLElement>(`[data-testid="${focusId}"]`);
      if (same !== null) same.focus();
      else if (!st.root.hidden) st.root.focus();
    }
  }

  /** In-place updates that never rebuild: rings, badges, controls, status. */
  function refresh(): void {
    if (st.view.kind === "none") return;
    const voice = voiceStore.getState();
    const me = currentUserId();
    const channelId = st.view.dm.channelId;
    let speaker = "";
    for (const [userId, ref] of st.avatars) {
      const inCallHere = voice.currentChannelId === channelId;
      const u = voiceUser(voice, channelId, userId);
      const isSelf = userId === me;
      const muted = isSelf && inCallHere ? isSelfMuted(voice) : (u?.muted ?? false);
      const deafened = isSelf && inCallHere ? voice.localDeafened : (u?.deafened ?? false);
      const speaking = u?.speaking === true && !muted;
      ref.wrap.classList.toggle("dcp-avatar--speaking", speaking);
      const badge = deafened ? "headphones-off" : muted ? "mic-off" : null;
      ref.badge.hidden = badge === null;
      if (badge !== null && ref.badge.dataset.icon !== badge) {
        clearChildren(ref.badge);
        ref.badge.appendChild(createIcon(badge, 14));
        ref.badge.dataset.icon = badge;
        ref.badge.title = deafened ? d("deafened") : d("muted");
      }
      if (speaking && !isSelf && speaker === "") {
        speaker = resolvePerson(userId, st.view.dm, voice, me).name;
      }
      if (isSelf) dc.syncOwnShield(userId, ref, inCallHere ? voice : null);
      else dc.syncVerify(userId, ref, voice, st.view.dm);
    }
    if (st.speakingEl !== null) {
      const text = speaker === "" ? "" : ` · ${d("speaking", { name: speaker })}`;
      if (st.speakingEl.textContent !== text) setText(st.speakingEl, text);
    }

    if (st.view.kind === "connected" && st.statusEl !== null) {
      setText(st.statusEl, connectedStatus(st.view, voice.voiceStatus));
    }
    if (st.securedEl !== null) {
      const connected = voice.voiceStatus === "connected";
      const degraded = connected && voice.encryptionDegraded === true;
      st.securedEl.hidden = !connected;
      st.securedEl.classList.toggle("dcp-secured--degraded", degraded);
      setText(st.securedEl, degraded ? t("encryption.unsecured") : t("encryption.secured"));
      st.securedEl.title = degraded ? t("encryption.unsecuredLabel") : t("encryption.securedLabel");
    }

    // Controls: the widget's rules. Socket down freezes camera and share
    // (Leave stays live; mute and deafen apply locally and are restated when
    // the socket returns); a moderator mute is not ours to lift.
    const frozen = uiStore.getState().connectionStatus !== "connected";
    const reason = frozen ? t("status.notConnected") : "";
    // No room to attach a camera or screen to until the join has connected.
    const connecting = isConnecting(voice.voiceStatus);
    const { mute, deafen, camera, share } = st.controls;
    if (mute !== null) {
      const selfMuted = isSelfMuted(voice);
      mute.setAttribute("aria-pressed", String(selfMuted));
      swapIcon(mute, selfMuted || voice.listenOnly ? "mic-off" : "mic", 20);
      mute.disabled = voice.localServerMuted === true || voice.listenOnly;
      mute.title =
        voice.localServerMuted === true
          ? t("widget.mutedByModerator")
          : voice.listenOnly
            ? t("widget.control.listenOnly")
            : t("widget.control.mute");
    }
    if (deafen !== null) {
      deafen.setAttribute("aria-pressed", String(voice.localDeafened));
      swapIcon(deafen, voice.localDeafened ? "headphones-off" : "headphones", 20);
      deafen.disabled = voice.localServerDeafened === true;
      deafen.title =
        voice.localServerDeafened === true
          ? t("widget.deafenedByModerator")
          : t("widget.control.deafen");
    }
    if (camera !== null) {
      camera.setAttribute("aria-pressed", String(voice.localCamera));
      swapIcon(camera, voice.localCamera ? "camera-off" : "camera", 20);
      camera.disabled = frozen || connecting;
      camera.title = reason || (connecting ? t("status.joining") : t("widget.control.camera"));
    }
    if (share !== null) {
      share.setAttribute("aria-pressed", String(voice.localScreenshare));
      swapIcon(share, voice.localScreenshare ? "monitor-off" : "monitor", 20);
      const block = shareBlockReason(voice);
      share.disabled = frozen || connecting || block !== null;
      share.title = reason || (connecting ? t("status.joining") : (block ?? d("share")));
    }
    tick();
  }

  function tick(): void {
    const text = st.answeredAt === null ? "00:00" : formatElapsed(Date.now() - st.answeredAt);
    for (const el of st.timerEls) if (el.textContent !== text) setText(el, text);
  }

  function syncTimer(): void {
    const running = st.timerEls.length > 0;
    if (running && st.timerInterval === null) st.timerInterval = setInterval(tick, 1000);
    if (!running && st.timerInterval !== null) {
      clearInterval(st.timerInterval);
      st.timerInterval = null;
    }
  }

  function update(): void {
    // A late ring-state change during page teardown must not re-arm the timer.
    if (st.destroyed) return;
    st.view = computeView();
    // Names and avatars are part of the structure: a rename redraws the stage
    // and the captions.
    const key =
      st.view.kind === "none"
        ? "none"
        : `${keyOf(st.view)}|${callName(st.view.dm, currentUserId())}|${identitiesOf(st.view)}`;
    if (key !== st.structureKey) {
      st.structureKey = key;
      rebuild();
      dc.announce();
    }
    refresh();
    syncTimer();
    const hosting = `${String(inCallChannel())}|${String(videoElement() !== null)}`;
    if (hosting !== st.hostSignature) {
      st.hostSignature = hosting;
      st.options.onVideoHostChange?.();
    }
  }

  /** The voice channel of the call this panel is showing you in, or null. */
  function inCallChannel(): number | null {
    if (
      st.view.kind === "connected" ||
      st.view.kind === "outgoing" ||
      st.view.kind === "unanswered"
    ) {
      return st.view.dm.channelId;
    }
    return null;
  }

  /** Collapsed, the panel shows no video (only ringing and connected
   *  collapse); a stream never expands it on its own. */
  function videoElement(): HTMLElement | null {
    if (inCallChannel() === null) return null;
    return st.collapsed && st.view.kind !== "unanswered" ? null : st.videoEl;
  }

  return {
    mount(container: Element): void {
      container.appendChild(st.root);
      const tiles = new MutationObserver((records) => {
        for (const [userId, ref] of st.avatars) {
          const shield = ref.verify;
          const detached =
            shield !== null &&
            records.some((r) =>
              Array.from(r.removedNodes).some((n) => n === shield || n.contains(shield)),
            );
          dc.placeShield(userId, ref);
          const active = document.activeElement;
          if (
            detached &&
            shield === st.focusedShield &&
            (active === null || active === document.body)
          ) {
            st.focusedShield = null;
            dc.focusFallback(userId)?.focus();
          }
        }
      });
      tiles.observe(st.videoEl, { childList: true, subtree: true });
      st.disposable.addCleanup(() => tiles.disconnect());
      st.unsubs.push(
        voiceStore.subscribe(() => update()),
        channelsStore.subscribeSelector(
          (s) => s.activeChannelId,
          () => update(),
        ),
        dmStore.subscribeSelector(
          (s) => s.channels,
          () => update(),
        ),
        membersStore.subscribeSelector(
          (s) => s.members,
          () => update(),
        ),
        uiStore.subscribeSelector(
          (s) => s.connectionStatus,
          () => update(),
        ),
      );
      update();
    },
    destroy(): void {
      st.destroyed = true;
      st.focusedShield = null;
      if (st.peopleGiven) st.options.videoGrid?.setPeople([]);
      if (st.timerInterval !== null) {
        clearInterval(st.timerInterval);
        st.timerInterval = null;
      }
      for (const unsub of st.unsubs) unsub();
      st.unsubs.length = 0;
      st.disposable.destroy();
      st.root.remove();
    },
    setIncoming(ring: RingState | null): void {
      st.incoming = ring;
      update();
    },
    setOutgoing(state: OutgoingCallState | null): void {
      st.outgoing = state;
      update();
    },
    showsRingFor(channelId: number): boolean {
      return st.view.kind === "incoming" && st.view.dm.channelId === channelId;
    },
    ownsCall(channelId: number): boolean {
      return inCallChannel() === channelId;
    },
    videoElement,
    setVideoActive(active: boolean): void {
      if (active === st.videoActive) return;
      st.videoActive = active;
      update();
    },
  };
}
