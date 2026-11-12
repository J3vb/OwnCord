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
 * On a phone the open call is the call view: it takes the chat column, Back
 * collapses it to the call bar above the chat, and reopening the DM (from the
 * call bar, say) opens it again. The stylesheet does the layout.
 *
 * The DOM is rebuilt only when the panel's structure changes (state, who is in
 * the room and their names and avatars, collapsed); speaking rings, mute badges, control states and the
 * timer update in place, so a speaking tick never re-fetches an avatar or drops
 * keyboard focus.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { loadPref } from "@lib/prefs/preferences";
import type { MountableComponent } from "@lib/text/safeRender";
import { claimBack, type BackClaim } from "@lib/ui/backHistory";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { RingState, OutgoingCallState } from "@lib/voice/callRing";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { uiStore } from "@stores/ui.store";
import type { VideoGridComponent } from "../voice/videoGrid/VideoGrid";
import { dmCallText as d } from "../../i18n/dmCall";
import {
  type AvatarRef,
  callName,
  currentUserId,
  deriveCallView,
  type DmCallView,
} from "./DmCallViewModel";
import { HEIGHT_PREF, MIN_HEIGHT } from "./dm-call/dmCallShared";
import type { DmCallState, DmCallApi } from "./dm-call/dmCallState";
import { createDmCallRender } from "./dm-call/dmCallRender";
import { createDmCallRefresh } from "./dm-call/dmCallRefresh";
import { createDmCallRebuild } from "./dm-call/dmCallRebuild";
import { createDmCallResize } from "./dm-call/dmCallResize";
import { createDmCallVerify, identitiesOf } from "./dm-call/dmCallVerify";
import { createRouteSlot } from "../voice/routeSlot";
import { createTalkSlot } from "../voice/talkSlot";

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
// notice, and what the Android call notifications' buttons do. Re-exported
// here so they ride in this panel's lazy chunk (the page imports the panel at
// mount) instead of a second dynamic chunk in MainPage, which would push its
// bundle budget over.
export {
  alertIncomingCall,
  alertMissedCall,
  alertRedial,
  alertSupersededCall,
  clearIncomingCall,
} from "./callAlerts";
export { followCallActions } from "./callNotificationActions";

/** Outgoing and connected are the call view; the rest never collapse. */
const isCallView = (kind: DmCallView["kind"]): boolean =>
  kind === "outgoing" || kind === "connected";

/** Voice fields that tick without changing anything this panel draws: the
 *  local input gate's verdict and other channels' rosters (speaking flips). */
const UNDRAWN_VOICE_FIELDS: ReadonlySet<string> = new Set(["voiceUsers", "localGateSpeaking"]);

/** What the panel reads from the voice store, as a flat list for the store's
 *  element-wise compare: every other field, plus the rosters of the DM rooms
 *  and the room you are in. */
export function panelVoiceKey(voice: VoiceState): unknown[] {
  const key: unknown[] = [];
  for (const [field, value] of Object.entries(voice)) {
    if (!UNDRAWN_VOICE_FIELDS.has(field)) key.push(field, value);
  }
  if (voice.currentChannelId !== null) key.push(voice.voiceUsers.get(voice.currentChannelId));
  for (const dm of dmStore.getState().channels) key.push(voice.voiceUsers.get(dm.channelId));
  return key;
}

export function createDmCallPanel(options: DmCallPanelOptions): DmCallPanelComponent {
  const disposable = new Disposable();
  const st: DmCallState = {
    options,
    disposable,
    unsubs: [],
    talkSlot: createTalkSlot("bar"),
    routeSlot: createRouteSlot("dm"),
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
    secured: null,
    timerEls: [],
    speakingEl: null,
    timerInterval: null,
    peerRoom: null,
    answeredAt: null,
    resizeOpts: { signal: disposable.signal },
    focusedShield: null,
  };
  disposable.addCleanup(() => st.talkSlot.clear());
  disposable.addCleanup(() => st.routeSlot.clear());
  const dc = {} as DmCallApi;
  Object.assign(dc, createDmCallRender(st, dc), createDmCallVerify(st, dc), { update });

  const { applyHeight } = createDmCallResize(st);
  const { rebuild } = createDmCallRebuild(st, dc, applyHeight);
  const { refresh, tick } = createDmCallRefresh(st, dc);

  st.root.hidden = true;

  appendChildren(st.root, st.body, st.resizer, st.live);

  /** Back collapses the call view while it is up on a phone. */
  let backClaim: BackClaim | null = null;
  /** The DM whose call the panel showed at the last update; null while hidden. */
  let shownDm: number | null = null;
  /** The view kind at the last update. */
  let shownKind: DmCallView["kind"] = "none";

  /** On a phone, coming back to the call's DM, or a new call starting in it
   *  (a ring sent again, a ring answered, a join), opens the call view. A call
   *  going from ringing to connected keeps the user's choice. */
  function expandOnReturn(): void {
    const dm = st.view.kind === "none" ? null : st.view.dm.channelId;
    const kind = st.view.kind;
    const returned = dm !== shownDm;
    const started = isCallView(kind) && !isCallView(shownKind);
    shownDm = dm;
    shownKind = kind;
    if (dm !== null && (returned || started) && isPhoneLayout()) st.collapsed = false;
  }

  function syncBackClaim(): void {
    const wanted = isCallView(st.view.kind) && !st.collapsed && isPhoneLayout();
    if (wanted && backClaim === null) {
      backClaim = claimBack(() => {
        backClaim = null;
        const hadFocus = st.root.contains(document.activeElement);
        st.collapsed = true;
        update();
        // The control that had focus may be one the call bar leaves out.
        const active = document.activeElement;
        if (hadFocus && (active === null || active === document.body)) {
          st.body.querySelector<HTMLElement>("[data-testid='dcp-collapse']")?.focus();
        }
      });
    } else if (!wanted && backClaim !== null) {
      backClaim.release();
      backClaim = null;
    }
  }

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

  // --- Update ---------------------------------------------------------------

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
    expandOnReturn();
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
    syncBackClaim();
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
      // Turning the device moves the window onto or off the phone layout.
      st.disposable.onEvent(window, "resize", () => update());
      st.unsubs.push(
        voiceStore.subscribeSelector(panelVoiceKey, () => update()),
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
      backClaim?.release();
      backClaim = null;
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
