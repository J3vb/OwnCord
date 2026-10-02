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
import type { IconName } from "@lib/icons";
import type { AvatarSubject } from "@lib/avatar";
import { createAvatarElement } from "@components/message-list/avatar";
import type { MountableComponent } from "@lib/safe-render";
import type { RingState, OutgoingCallState } from "@lib/call-ring";
import { voiceStore, isSelfMuted } from "@stores/voice.store";
import type { VoiceState, VoiceUser } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { formatElapsed, headerStatusText } from "@components/VoiceWidget";
import type { GridPerson, VideoGridComponent } from "@components/VideoGrid";
import { voiceText as t } from "../i18n/voice";
import { dmCallText as d } from "../i18n/dmCall";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type DmCallView =
  | { readonly kind: "none" }
  | { readonly kind: "incoming"; readonly dm: DmChannel; readonly ring: RingState }
  | {
      readonly kind: "live";
      readonly dm: DmChannel;
      /** Everyone in the DM's room (you are not). */
      readonly inRoom: readonly number[];
      /** The voice channel you would leave by joining, or null. */
      readonly otherChannelId: number | null;
    }
  | { readonly kind: "outgoing"; readonly dm: DmChannel; readonly pending: readonly number[] }
  | {
      readonly kind: "unanswered";
      readonly dm: DmChannel;
      readonly reason: "declined" | "no-answer";
    }
  | { readonly kind: "connected"; readonly dm: DmChannel; readonly inRoom: readonly number[] };

export interface DmCallViewInput {
  readonly activeChannelId: number | null;
  readonly dms: readonly DmChannel[];
  readonly voice: Pick<VoiceState, "currentChannelId" | "voiceUsers">;
  readonly selfId: number;
  readonly incoming: RingState | null;
  readonly outgoing: OutgoingCallState | null;
}

/** Which panel, if any, the open channel shows. Pure: the whole decision. */
export function deriveCallView(input: DmCallViewInput): DmCallView {
  const { activeChannelId, voice, selfId } = input;
  if (activeChannelId === null) return { kind: "none" };
  const dm = input.dms.find((c) => c.channelId === activeChannelId);
  if (dm === undefined) return { kind: "none" };

  const inCall = voice.currentChannelId === dm.channelId;
  const roster = voice.voiceUsers.get(dm.channelId);
  const others = roster === undefined ? [] : [...roster.keys()].filter((id) => id !== selfId);

  if (!inCall && input.incoming !== null && input.incoming.channelId === dm.channelId) {
    return { kind: "incoming", dm, ring: input.incoming };
  }
  if (inCall) {
    const out = input.outgoing;
    // Anyone else in the room means the call is up, whatever the ring said.
    if (others.length === 0 && out !== null && out.channelId === dm.channelId) {
      if (out.phase === "ringing") return { kind: "outgoing", dm, pending: out.pending };
      return {
        kind: "unanswered",
        dm,
        reason: out.phase === "declined" ? "declined" : "no-answer",
      };
    }
    return { kind: "connected", dm, inRoom: [selfId, ...others] };
  }
  if (others.length > 0) {
    return { kind: "live", dm, inRoom: others, otherChannelId: voice.currentChannelId };
  }
  return { kind: "none" };
}

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

interface Person {
  readonly name: string;
  readonly subject: AvatarSubject;
}

interface AvatarRef {
  readonly wrap: HTMLElement;
  readonly badge: HTMLElement;
}

interface ControlRefs {
  mute: HTMLButtonElement | null;
  deafen: HTMLButtonElement | null;
  camera: HTMLButtonElement | null;
  share: HTMLButtonElement | null;
}

/** Resolve a user the way every other identity surface does: the members
 *  store first, then the DM's own participant copy, then the voice roster. */
function resolvePerson(userId: number, dm: DmChannel, voice: VoiceState, selfId: number): Person {
  if (userId === selfId) {
    const me = authStore.getState().user;
    return {
      name: d("you"),
      subject: {
        username: me?.username ?? "",
        displayName: me?.display_name ?? null,
        avatar: me?.avatar ?? null,
      },
    };
  }
  const member = membersStore.getState().members.get(userId);
  if (member !== undefined) {
    return {
      name: memberDisplayName(member),
      subject: {
        username: member.username,
        displayName: member.displayName,
        avatar: member.avatar,
      },
    };
  }
  const p = dm.participants.find((x) => x.id === userId);
  if (p !== undefined) {
    return {
      name: (p.displayName ?? "") || p.username,
      subject: { username: p.username, displayName: p.displayName ?? null, avatar: p.avatar },
    };
  }
  const username = voice.voiceUsers.get(dm.channelId)?.get(userId)?.username ?? "";
  return { name: username, subject: { username } };
}

/** What a call is called: the other person in a 1:1 (resolved like the
 *  stage labels and the ring banner), the DM's own name for a group. */
function callName(dm: DmChannel, selfId: number): string {
  if (dm.isGroup) return dmDisplayName(dm);
  return (
    resolvePerson(dm.recipient.id, dm, voiceStore.getState(), selfId).name || dmDisplayName(dm)
  );
}

function voiceUser(voice: VoiceState, channelId: number, userId: number): VoiceUser | undefined {
  return voice.voiceUsers.get(channelId)?.get(userId);
}

function swapIcon(btn: HTMLElement, name: IconName, size: number): void {
  const current = btn.querySelector("svg");
  if (current?.getAttribute("data-icon") === name) return;
  current?.remove();
  btn.insertBefore(createIcon(name, size), btn.firstChild);
}

function currentUserId(): number {
  return authStore.getState().user?.id ?? 0;
}

function caption(main: string, sub: string): HTMLElement[] {
  return [
    createElement("div", { class: "dcp-caption", "data-testid": "dcp-caption" }, main),
    createElement("div", { class: "dcp-sub" }, sub),
  ];
}

// DP-24: the OS call notification, urgent attention request and missed-call
// notice. Re-exported here so they ride in this panel's lazy chunk (the page
// imports the panel at mount) instead of a second dynamic chunk in MainPage,
// which would push its bundle budget over.
export { alertIncomingCall, alertMissedCall } from "../features/direct-messages/callAlerts";

export function createDmCallPanel(options: DmCallPanelOptions): DmCallPanelComponent {
  const disposable = new Disposable();
  const unsubs: Array<() => void> = [];

  let incoming: RingState | null = null;
  let outgoing: OutgoingCallState | null = null;
  /** Remembered for the session, not per DM (the mock's state 6). */
  let collapsed = false;
  let view: DmCallView = { kind: "none" };
  let structureKey = "";
  /** Any camera or screen share is on in the call (VideoModeController). */
  let videoActive = false;
  /** The avatar tiles handed to the grid on the last rebuild. */
  let people: GridPerson[] = [];
  let peopleGiven = false;
  /** Holds the shared video grid while the panel shows it; kept across
   *  rebuilds so the grid is re-seated, never recreated. */
  const videoEl = createElement("div", { class: "dcp-video", "data-testid": "dcp-video" });
  /** What the owner last heard about hosting, to tell it only on a change. */
  let hostSignature = "";
  let destroyed = false;

  const root = createElement("section", {
    class: "dm-call-panel",
    "data-testid": "dm-call-panel",
    tabindex: "-1",
  });
  root.hidden = true;
  const body = createElement("div", { class: "dcp-body" });
  // Present from mount so it is heard when it fills (a region inserted
  // already filled is skipped). Outside `body`, which is rebuilt.
  const live = createElement("div", {
    class: "sr-only",
    role: "status",
    "aria-live": "polite",
    "data-testid": "dm-call-live",
  });
  appendChildren(root, body, live);

  // Per-render references for the in-place refresh.
  let avatars = new Map<number, AvatarRef>();
  let controls: ControlRefs = { mute: null, deafen: null, camera: null, share: null };
  let statusEl: HTMLElement | null = null;
  let securedEl: HTMLElement | null = null;
  let timerEls: HTMLElement[] = [];
  let speakingEl: HTMLElement | null = null;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  function computeView(): DmCallView {
    return deriveCallView({
      activeChannelId: channelsStore.getState().activeChannelId,
      dms: dmStore.getState().channels,
      voice: voiceStore.getState(),
      selfId: currentUserId(),
      incoming,
      outgoing,
    });
  }

  function keyOf(v: DmCallView): string {
    switch (v.kind) {
      case "incoming":
        return `incoming|${v.dm.channelId}|${v.ring.fromUserId}|${v.ring.fromUsername}`;
      case "live":
        return `live|${v.dm.channelId}|${v.inRoom.join(",")}|${String(v.otherChannelId)}`;
      case "outgoing":
        return `outgoing|${v.dm.channelId}|${v.pending.join(",")}|${String(collapsed)}|${String(videoActive)}`;
      case "unanswered":
        return `unanswered|${v.dm.channelId}|${v.reason}|${String(videoActive)}`;
      case "connected":
        return `connected|${v.dm.channelId}|${v.inRoom.join(",")}|${String(collapsed)}|${String(videoActive)}`;
      default:
        return "none";
    }
  }

  /** Who the panel may draw, by name and avatar, so a rename or a new avatar
   *  redraws the stage but a presence flip does not. */
  function identitiesOf(v: Exclude<DmCallView, { kind: "none" }>): string {
    const me = currentUserId();
    const voice = voiceStore.getState();
    const ids = new Set([me, ...v.dm.participants.map((p) => p.id)]);
    if (v.kind === "incoming") ids.add(v.ring.fromUserId);
    if (v.kind === "live" || v.kind === "connected") for (const id of v.inRoom) ids.add(id);
    return [...ids]
      .map((id) => {
        const { name, subject } = resolvePerson(id, v.dm, voice, me);
        return `${id}:${name}:${subject.username}:${subject.displayName ?? ""}:${subject.avatar ?? ""}`;
      })
      .join(",");
  }

  // --- Building blocks ------------------------------------------------------

  function avatar(userId: number, dm: DmChannel, size: "lg" | "sm", extra = ""): HTMLElement {
    const who = resolvePerson(userId, dm, voiceStore.getState(), currentUserId());
    const wrap = createAvatarElement(who.subject, {
      className: `dcp-avatar dcp-avatar--${size}${extra === "" ? "" : ` ${extra}`}`,
      attrs: { "data-user-id": String(userId) },
    });
    const badge = createElement("span", { class: "dcp-avatar-badge" });
    badge.hidden = true;
    wrap.appendChild(badge);
    avatars.set(userId, { wrap, badge });
    return wrap;
  }

  function person(userId: number, dm: DmChannel, extra = ""): HTMLElement {
    const col = createElement("div", { class: "dcp-person" });
    const label = createElement(
      "span",
      { class: "dcp-person-name" },
      resolvePerson(userId, dm, voiceStore.getState(), currentUserId()).name,
    );
    appendChildren(col, avatar(userId, dm, "lg", extra), label);
    return col;
  }

  function roundButton(
    label: string,
    icon: IconName,
    cls: string,
    testid: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      type: "button",
      class: `dcp-btn ${cls}`,
      "aria-label": label,
      title: label,
      "data-testid": testid,
    });
    btn.appendChild(createIcon(icon, 20));
    btn.addEventListener("click", onClick, { signal: disposable.signal });
    return btn;
  }

  function textButton(
    label: string,
    cls: string,
    testid: string,
    onClick: () => void,
    icon?: IconName,
  ): HTMLButtonElement {
    const btn = createElement("button", { type: "button", class: cls, "data-testid": testid });
    if (icon !== undefined) btn.appendChild(createIcon(icon, 16));
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", onClick, { signal: disposable.signal });
    return btn;
  }

  function callControls(compact: boolean): HTMLElement {
    const bar = createElement("div", {
      class: "dcp-controls",
      role: "toolbar",
      "aria-label": d("controls"),
    });
    controls = {
      mute: roundButton(
        t("widget.control.mute"),
        "mic",
        "dcp-btn--neg",
        "dcp-mute",
        options.onMuteToggle,
      ),
      deafen: roundButton(
        t("widget.control.deafen"),
        "headphones",
        "dcp-btn--neg",
        "dcp-deafen",
        options.onDeafenToggle,
      ),
      camera: roundButton(
        t("widget.control.camera"),
        "camera",
        "dcp-btn--pos",
        "dcp-camera",
        options.onCameraToggle,
      ),
      share: roundButton(
        d("share"),
        "monitor",
        "dcp-btn--pos",
        "dcp-share",
        options.onScreenshareToggle,
      ),
    };
    appendChildren(bar, controls.mute!, controls.deafen!, controls.camera!, controls.share!);
    if (!compact)
      bar.appendChild(createElement("span", { class: "dcp-sep", "aria-hidden": "true" }));
    bar.appendChild(
      roundButton(d("leave"), "phone-off", "dcp-btn--hang", "dcp-leave", options.onLeave),
    );
    return bar;
  }

  function collapseButton(): HTMLButtonElement {
    const btn = createElement("button", {
      type: "button",
      class: "dcp-collapse",
      "aria-expanded": String(!collapsed),
      "aria-label": collapsed ? d("expandLabel") : d("collapseLabel"),
      "data-testid": "dcp-collapse",
    });
    btn.appendChild(createIcon(collapsed ? "chevron-down" : "chevron-up", 14));
    btn.appendChild(document.createTextNode(collapsed ? d("expand") : d("collapse")));
    btn.addEventListener(
      "click",
      () => {
        collapsed = !collapsed;
        update();
      },
      { signal: disposable.signal },
    );
    return btn;
  }

  function topBar(
    status: string,
    tone: "" | "warn" | "bad",
    withCall: boolean,
    collapsible = false,
  ): HTMLElement {
    const bar = createElement("div", { class: "dcp-top" });
    statusEl = createElement(
      "span",
      { class: tone === "" ? "dcp-status" : `dcp-status dcp-status--${tone}` },
      status,
    );
    bar.appendChild(statusEl);
    if (withCall) {
      securedEl = createElement("span", { class: "dcp-secured", "data-testid": "dcp-secured" });
      const timer = createElement("span", { class: "dcp-timer" }, "00:00");
      timerEls.push(timer);
      appendChildren(bar, securedEl, timer);
    }
    bar.appendChild(createElement("span", { class: "dcp-spacer" }));
    if (collapsible) bar.appendChild(collapseButton());
    return bar;
  }

  /** The shared grid moves into videoEl (VideoModeController); everyone in
   *  `ids` without a camera is an avatar tile in it, kept live by refresh();
   *  the `ringing` ones keep their dimmed pulse. */
  function videoStage(
    dm: DmChannel,
    ids: readonly number[],
    ringing: readonly number[] = [],
  ): HTMLElement {
    root.classList.add("dm-call-panel--video");
    const me = currentUserId();
    const voice = voiceStore.getState();
    people = ids.map((id) => ({
      userId: id,
      label: resolvePerson(id, dm, voice, me).name,
      content: avatar(id, dm, "lg", ringing.includes(id) ? "dcp-avatar--ringing" : ""),
    }));
    return videoEl;
  }

  /** Append `nodes` to the body in order, around a videoEl already there
   *  rather than moving it. */
  function fill(...nodes: HTMLElement[]): void {
    const at = nodes.indexOf(videoEl);
    if (at < 0 || videoEl.parentNode !== body) {
      appendChildren(body, ...nodes);
      return;
    }
    videoEl.before(...nodes.slice(0, at));
    videoEl.after(...nodes.slice(at + 1));
  }

  // --- Per-state renders ----------------------------------------------------

  function renderIncoming(v: Extract<DmCallView, { kind: "incoming" }>): void {
    root.classList.add("dm-call-panel--expanded");
    const stage = createElement("div", { class: "dcp-stage" });
    stage.appendChild(person(v.ring.fromUserId, v.dm, "dcp-avatar--ringing"));
    const actions = createElement("div", { class: "dcp-controls" });
    appendChildren(
      actions,
      roundButton(d("accept"), "phone", "dcp-btn--accept", "dcp-accept", () =>
        options.onAccept(false),
      ),
      textButton(
        d("acceptVideo"),
        "btn-ghost dcp-pill",
        "dcp-accept-video",
        () => options.onAccept(true),
        "camera",
      ),
      roundButton(d("decline"), "phone-off", "dcp-btn--hang", "dcp-decline", () =>
        options.onDecline(),
      ),
    );
    appendChildren(
      body,
      topBar(t("call.incoming"), "warn", false),
      stage,
      ...caption(d("isCalling", { name: v.ring.fromUsername }), d("voiceCall")),
      actions,
    );
  }

  function renderLive(v: Extract<DmCallView, { kind: "live" }>): void {
    root.classList.add("dm-call-panel--strip");
    const voice = voiceStore.getState();
    const first = v.inRoom[0];
    const status =
      v.inRoom.length === 1 && first !== undefined
        ? d("liveOne", { name: resolvePerson(first, v.dm, voice, currentUserId()).name })
        : d("liveMany", { count: v.inRoom.length });
    const row = createElement("div", { class: "dcp-row" });
    const faces = createElement("div", { class: "dcp-faces" });
    for (const id of v.inRoom) faces.appendChild(avatar(id, v.dm, "sm"));
    const text = createElement("div", { class: "dcp-row-text" });
    let hint = d("joinHint");
    if (v.otherChannelId !== null) {
      const other = channelsStore.getState().channels.get(v.otherChannelId);
      const otherDm = dmStore.getState().channels.find((c) => c.channelId === v.otherChannelId);
      const name =
        otherDm !== undefined
          ? dmDisplayName(otherDm)
          : (other?.name ?? t("widget.channelFallback"));
      hint = d("switchHint", { channel: name });
    }
    appendChildren(
      text,
      createElement("div", { class: "dcp-caption" }, d("inProgress")),
      createElement("div", { class: "dcp-sub" }, hint),
    );
    const join = textButton(
      v.otherChannelId === null ? d("join") : d("switch"),
      "btn-primary dcp-pill",
      "dcp-join",
      () => options.onJoin(v.dm.channelId),
      "phone",
    );
    appendChildren(row, faces, text, join);
    appendChildren(body, topBar(status, "", false), row);
  }

  function renderOutgoing(v: Extract<DmCallView, { kind: "outgoing" }>): void {
    if (collapsed) {
      renderCollapsed(v.dm, [currentUserId()], d("calling"));
      return;
    }
    root.classList.add("dm-call-panel--expanded");
    const me = currentUserId();
    const callees =
      v.pending.length > 0 ? v.pending : v.dm.participants.map((p) => p.id).slice(0, 1);
    let stage: HTMLElement;
    if (videoActive) {
      stage = videoStage(v.dm, [me, ...callees], callees);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      stage.appendChild(person(me, v.dm));
      for (const id of callees) stage.appendChild(person(id, v.dm, "dcp-avatar--ringing"));
    }
    fill(
      topBar(d("calling"), "warn", true, true),
      stage,
      ...caption(d("callingName", { name: callName(v.dm, currentUserId()) }), d("ringingHint")),
      callControls(false),
    );
  }

  function renderUnanswered(v: Extract<DmCallView, { kind: "unanswered" }>): void {
    root.classList.add("dm-call-panel--expanded");
    const name = callName(v.dm, currentUserId());
    // Nobody else is in the room (deriveCallView hands us "unanswered" only
    // then), so the absent callee has no tile: showing their placeholder would
    // look like they joined. Ring again restores the ringing tile.
    const ids = [currentUserId()];
    let stage: HTMLElement;
    if (videoActive) {
      stage = videoStage(v.dm, ids);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      for (const id of ids) stage.appendChild(person(id, v.dm));
    }
    const actions = createElement("div", { class: "dcp-controls" });
    appendChildren(
      actions,
      textButton(d("ringAgain"), "btn-primary dcp-pill", "dcp-ring-again", () =>
        options.onRingAgain(v.dm.channelId),
      ),
      textButton(d("leave"), "btn-ghost dcp-pill", "dcp-leave-call", options.onLeave),
    );
    const declined = v.reason === "declined";
    fill(
      topBar(declined ? d("declinedStatus", { name }) : d("noAnswerStatus"), "bad", true),
      stage,
      ...caption(
        declined ? d("declined", { name }) : d("noAnswer", { name }),
        d("stillInCall", { name }),
      ),
      actions,
    );
  }

  function renderConnected(v: Extract<DmCallView, { kind: "connected" }>): void {
    const status = headerStatusText(voiceStore.getState().voiceStatus);
    if (collapsed) {
      renderCollapsed(v.dm, v.inRoom, status);
      return;
    }
    root.classList.add("dm-call-panel--expanded");
    let stage: HTMLElement;
    if (videoActive) {
      stage = videoStage(v.dm, v.inRoom);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      for (const id of v.inRoom) stage.appendChild(person(id, v.dm));
    }
    fill(topBar(status, "", true, true), stage, callControls(false));
  }

  function renderCollapsed(dm: DmChannel, ids: readonly number[], status: string): void {
    root.classList.add("dm-call-panel--collapsed");
    const row = createElement("div", { class: "dcp-row" });
    const faces = createElement("div", { class: "dcp-faces" });
    for (const id of ids) faces.appendChild(avatar(id, dm, "sm"));
    const text = createElement("div", { class: "dcp-row-text" });
    statusEl = createElement("b", { class: "dcp-status" }, status);
    const timer = createElement("span", { class: "dcp-timer" }, "00:00");
    timerEls.push(timer);
    speakingEl = createElement("span", { class: "dcp-speaking" });
    appendChildren(text, statusEl, " · ", timer, speakingEl);
    const ctrl = callControls(true);
    ctrl.classList.add("dcp-controls--compact");
    appendChildren(row, faces, text, ctrl, collapseButton());
    body.appendChild(row);
  }

  // --- Update ---------------------------------------------------------------

  function rebuild(): void {
    // Keep keyboard focus on the same control across a rebuild (a mute click
    // must not drop focus to <body>); fall back to the region itself.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && root.contains(active);
    const focusId = hadFocus ? (active.dataset.testid ?? "") : "";

    for (const child of Array.from(body.childNodes)) if (child !== videoEl) child.remove();
    avatars = new Map();
    people = [];
    controls = { mute: null, deafen: null, camera: null, share: null };
    statusEl = null;
    securedEl = null;
    speakingEl = null;
    timerEls = [];
    root.classList.remove(
      "dm-call-panel--expanded",
      "dm-call-panel--collapsed",
      "dm-call-panel--strip",
      "dm-call-panel--video",
    );

    switch (view.kind) {
      case "none":
        break;
      case "incoming":
        renderIncoming(view);
        break;
      case "live":
        renderLive(view);
        break;
      case "outgoing":
        renderOutgoing(view);
        break;
      case "unanswered":
        renderUnanswered(view);
        break;
      case "connected":
        renderConnected(view);
        break;
    }
    if (!root.classList.contains("dm-call-panel--video")) videoEl.remove();
    if (people.length > 0 || peopleGiven) {
      options.videoGrid?.setPeople(people);
      peopleGiven = people.length > 0;
    }
    root.hidden = view.kind === "none";
    if (view.kind === "none") root.removeAttribute("aria-label");
    else root.setAttribute("aria-label", d("region", { name: callName(view.dm, currentUserId()) }));
    root.dataset.state = view.kind;

    if (hadFocus) {
      const same =
        active.isConnected && videoEl.contains(active)
          ? active
          : focusId === ""
            ? null
            : body.querySelector<HTMLElement>(`[data-testid="${focusId}"]`);
      if (same !== null) same.focus();
      else if (!root.hidden) root.focus();
    }
  }

  function announce(): void {
    let text = "";
    if (view.kind === "incoming") text = d("isCalling", { name: view.ring.fromUsername });
    else if (view.kind === "outgoing")
      text = d("callingName", { name: callName(view.dm, currentUserId()) });
    else if (view.kind === "unanswered") {
      const name = callName(view.dm, currentUserId());
      text = view.reason === "declined" ? d("declined", { name }) : d("noAnswer", { name });
    }
    if (live.textContent !== text) setText(live, text);
  }

  /** In-place updates that never rebuild: rings, badges, controls, status. */
  function refresh(): void {
    if (view.kind === "none") return;
    const voice = voiceStore.getState();
    const me = currentUserId();
    const channelId = view.dm.channelId;
    let speaker = "";
    for (const [userId, ref] of avatars) {
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
        speaker = resolvePerson(userId, view.dm, voice, me).name;
      }
    }
    if (speakingEl !== null) {
      const text = speaker === "" ? "" : ` · ${d("speaking", { name: speaker })}`;
      if (speakingEl.textContent !== text) setText(speakingEl, text);
    }

    if (view.kind === "connected" && statusEl !== null) {
      setText(statusEl, headerStatusText(voice.voiceStatus));
    }
    if (securedEl !== null) {
      const connected = voice.voiceStatus === "connected";
      const degraded = connected && voice.encryptionDegraded === true;
      securedEl.hidden = !connected;
      securedEl.classList.toggle("dcp-secured--degraded", degraded);
      setText(securedEl, degraded ? t("encryption.unsecured") : t("encryption.secured"));
      securedEl.title = degraded ? t("encryption.unsecuredLabel") : t("encryption.securedLabel");
    }

    // Controls: the widget's rules. Socket down freezes the signalling
    // controls (Leave stays live); a moderator mute is not ours to lift.
    const frozen = uiStore.getState().connectionStatus !== "connected";
    const reason = frozen ? t("status.notConnected") : "";
    const { mute, deafen, camera, share } = controls;
    if (mute !== null) {
      const selfMuted = isSelfMuted(voice);
      mute.setAttribute("aria-pressed", String(selfMuted));
      swapIcon(mute, selfMuted || voice.listenOnly ? "mic-off" : "mic", 20);
      mute.disabled = frozen || voice.localServerMuted === true || voice.listenOnly;
      mute.title =
        voice.localServerMuted === true
          ? t("widget.mutedByModerator")
          : voice.listenOnly
            ? t("widget.control.listenOnly")
            : reason || t("widget.control.mute");
    }
    if (deafen !== null) {
      deafen.setAttribute("aria-pressed", String(voice.localDeafened));
      swapIcon(deafen, voice.localDeafened ? "headphones-off" : "headphones", 20);
      deafen.disabled = frozen || voice.localServerDeafened === true;
      deafen.title =
        voice.localServerDeafened === true
          ? t("widget.deafenedByModerator")
          : reason || t("widget.control.deafen");
    }
    if (camera !== null) {
      camera.setAttribute("aria-pressed", String(voice.localCamera));
      swapIcon(camera, voice.localCamera ? "camera-off" : "camera", 20);
      camera.disabled = frozen;
      camera.title = reason || t("widget.control.camera");
    }
    if (share !== null) {
      share.setAttribute("aria-pressed", String(voice.localScreenshare));
      swapIcon(share, voice.localScreenshare ? "monitor-off" : "monitor", 20);
      share.disabled = frozen;
      share.title = reason || d("share");
    }
    tick();
  }

  function tick(): void {
    const joinedAt = voiceStore.getState().joinedAt;
    const text = joinedAt === null ? "00:00" : formatElapsed(Date.now() - joinedAt);
    for (const el of timerEls) if (el.textContent !== text) setText(el, text);
  }

  function syncTimer(): void {
    const running = timerEls.length > 0;
    if (running && timerInterval === null) timerInterval = setInterval(tick, 1000);
    if (!running && timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function update(): void {
    // A late ring-state change during page teardown must not re-arm the timer.
    if (destroyed) return;
    view = computeView();
    // Names and avatars are part of the structure: a rename redraws the stage
    // and the captions.
    const key =
      view.kind === "none"
        ? "none"
        : `${keyOf(view)}|${callName(view.dm, currentUserId())}|${identitiesOf(view)}`;
    if (key !== structureKey) {
      structureKey = key;
      rebuild();
      announce();
    }
    refresh();
    syncTimer();
    const hosting = `${String(inCallChannel())}|${String(videoElement() !== null)}`;
    if (hosting !== hostSignature) {
      hostSignature = hosting;
      options.onVideoHostChange?.();
    }
  }

  /** The voice channel of the call this panel is showing you in, or null. */
  function inCallChannel(): number | null {
    if (view.kind === "connected" || view.kind === "outgoing" || view.kind === "unanswered") {
      return view.dm.channelId;
    }
    return null;
  }

  /** Collapsed, the panel shows no video (only ringing and connected
   *  collapse); a stream never expands it on its own. */
  function videoElement(): HTMLElement | null {
    if (inCallChannel() === null) return null;
    return collapsed && view.kind !== "unanswered" ? null : videoEl;
  }

  return {
    mount(container: Element): void {
      container.appendChild(root);
      unsubs.push(
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
      destroyed = true;
      if (peopleGiven) options.videoGrid?.setPeople([]);
      if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      disposable.destroy();
      root.remove();
    },
    setIncoming(ring: RingState | null): void {
      incoming = ring;
      update();
    },
    setOutgoing(state: OutgoingCallState | null): void {
      outgoing = state;
      update();
    },
    showsRingFor(channelId: number): boolean {
      return view.kind === "incoming" && view.dm.channelId === channelId;
    },
    ownsCall(channelId: number): boolean {
      return inCallChannel() === channelId;
    },
    videoElement,
    setVideoActive(active: boolean): void {
      if (active === videoActive) return;
      videoActive = active;
      update();
    },
  };
}
