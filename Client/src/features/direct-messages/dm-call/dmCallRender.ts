/**
 * Draws each DM call panel state: incoming, outgoing, unanswered, connected and
 * collapsed, with the avatars, buttons, top bar and video stage they share.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { createAvatarElement } from "../../profiles/avatar";
import { voiceStore, type VoiceStatus } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName, type DmChannel } from "@stores/dm.store";
import { headerStatusText } from "../../voice/voiceStatusText";
import { voiceText as t } from "../../../i18n/voice";
import { dmCallText as d } from "../../../i18n/dmCall";
import { canPublishScreen } from "../../voice/native/platform";
import {
  absentMembers,
  callName,
  caption,
  currentUserId,
  type DmCallView,
  resolvePerson,
} from "../DmCallViewModel";
import { ABSENT_CLASS } from "./dmCallShared";
import type { DmCallState, DmCallApi } from "./dmCallState";

/** Why the ring ended, as the header status or the caption. */
export function unansweredText(
  reason: Extract<DmCallView, { kind: "unanswered" }>["reason"],
  name: string,
  status: boolean,
): string {
  if (reason === "offline") return d("offline", { name });
  if (reason === "declined")
    return status ? d("declinedStatus", { name }) : d("declined", { name });
  return status ? d("noAnswerStatus") : d("noAnswer", { name });
}

/** The header status: who left once alone in a live call, else the voice state. */
export function connectedStatus(
  v: Extract<DmCallView, { kind: "connected" }>,
  status: VoiceStatus,
): string {
  return v.peerLeft && status !== "reconnecting"
    ? d("leftStatus", { name: callName(v.dm, currentUserId()) })
    : headerStatusText(status);
}

export function createDmCallRender(st: DmCallState, dc: DmCallApi) {
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
    if (extra.split(" ").includes(ABSENT_CLASS)) {
      // Every surface that draws a greyed member (stage, grid tile, live strip).
      wrap.title = d("notInCall");
      wrap.appendChild(createElement("span", { class: "sr-only" }, d("notInCall")));
    }
    st.avatars.set(userId, { wrap, badge, verify: null, verifyKey: "" });
    return wrap;
  }

  function person(userId: number, dm: DmChannel, extra = ""): HTMLElement {
    const absent = extra.split(" ").includes(ABSENT_CLASS);
    const col = createElement("div", {
      class: absent ? "dcp-person dcp-person--absent" : "dcp-person",
    });
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
    btn.addEventListener("click", onClick, { signal: st.disposable.signal });
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
    btn.addEventListener("click", onClick, { signal: st.disposable.signal });
    return btn;
  }

  function callControls(compact: boolean): HTMLElement {
    const bar = createElement("div", {
      class: "dcp-controls",
      role: "toolbar",
      "aria-label": d("controls"),
    });
    st.controls = {
      mute: roundButton(
        t("widget.control.mute"),
        "mic",
        "dcp-btn--neg",
        "dcp-mute",
        st.options.onMuteToggle,
      ),
      deafen: roundButton(
        t("widget.control.deafen"),
        "headphones",
        "dcp-btn--neg",
        "dcp-deafen",
        st.options.onDeafenToggle,
      ),
      camera: roundButton(
        t("widget.control.camera"),
        "camera",
        "dcp-btn--pos",
        "dcp-camera",
        st.options.onCameraToggle,
      ),
      share: roundButton(
        d("share"),
        "monitor",
        "dcp-btn--pos",
        "dcp-share",
        st.options.onScreenshareToggle,
      ),
    };
    appendChildren(bar, st.controls.mute!, st.controls.deafen!, st.controls.camera!);
    st.talkSlot.attach(bar);
    if (canPublishScreen()) {
      bar.appendChild(st.controls.share!);
    }
    if (!compact)
      bar.appendChild(createElement("span", { class: "dcp-sep", "aria-hidden": "true" }));
    bar.appendChild(
      roundButton(d("leave"), "phone-off", "dcp-btn--hang", "dcp-leave", st.options.onLeave),
    );
    return bar;
  }

  function collapseButton(): HTMLButtonElement {
    const btn = createElement("button", {
      type: "button",
      class: "dcp-collapse",
      "aria-expanded": String(!st.collapsed),
      "aria-label": st.collapsed ? d("expandLabel") : d("collapseLabel"),
      "data-testid": "dcp-collapse",
    });
    btn.appendChild(createIcon(st.collapsed ? "chevron-down" : "chevron-up", 14));
    btn.appendChild(document.createTextNode(st.collapsed ? d("expand") : d("collapse")));
    btn.addEventListener(
      "click",
      () => {
        st.collapsed = !st.collapsed;
        dc.update();
      },
      { signal: st.disposable.signal },
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
    st.statusEl = createElement(
      "span",
      { class: tone === "" ? "dcp-status" : `dcp-status dcp-status--${tone}` },
      status,
    );
    bar.appendChild(st.statusEl);
    if (withCall) {
      st.securedEl = createElement("span", { class: "dcp-secured", "data-testid": "dcp-secured" });
      const timer = createElement("span", { class: "dcp-timer" }, "00:00");
      st.timerEls.push(timer);
      appendChildren(bar, st.securedEl, timer);
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
    absent: readonly number[] = [],
  ): HTMLElement {
    st.root.classList.add("dm-call-panel--video");
    const me = currentUserId();
    const voice = voiceStore.getState();
    st.people = [...ids, ...absent].map((id) => ({
      userId: id,
      label: resolvePerson(id, dm, voice, me).name,
      content: avatar(
        id,
        dm,
        "lg",
        ringing.includes(id) ? "dcp-avatar--ringing" : absent.includes(id) ? ABSENT_CLASS : "",
      ),
      // Its avatars draw their own speaking ring and mute badge.
      marksOwnState: true as const,
    }));
    return st.videoEl;
  }

  /** Append `nodes` to the body in order, around a videoEl already there
   *  rather than moving it. */
  function fill(...nodes: HTMLElement[]): void {
    const at = nodes.indexOf(st.videoEl);
    if (at < 0 || st.videoEl.parentNode !== st.body) {
      appendChildren(st.body, ...nodes);
      return;
    }
    st.videoEl.before(...nodes.slice(0, at));
    st.videoEl.after(...nodes.slice(at + 1));
  }

  // --- Per-state renders ----------------------------------------------------

  function renderIncoming(v: Extract<DmCallView, { kind: "incoming" }>): void {
    st.root.classList.add("dm-call-panel--expanded");
    const stage = createElement("div", { class: "dcp-stage" });
    stage.appendChild(person(v.ring.fromUserId, v.dm, "dcp-avatar--ringing"));
    const actions = createElement("div", { class: "dcp-controls" });
    appendChildren(
      actions,
      roundButton(d("accept"), "phone", "dcp-btn--accept", "dcp-accept", () =>
        st.options.onAccept(false),
      ),
      textButton(
        d("acceptVideo"),
        "btn-ghost dcp-pill",
        "dcp-accept-video",
        () => st.options.onAccept(true),
        "camera",
      ),
      roundButton(d("decline"), "phone-off", "dcp-btn--hang", "dcp-decline", () =>
        st.options.onDecline(),
      ),
    );
    appendChildren(
      st.body,
      topBar(t("call.incoming"), "warn", false),
      stage,
      ...caption(d("isCalling", { name: v.ring.fromUsername }), d("voiceCall")),
      actions,
    );
  }

  function renderLive(v: Extract<DmCallView, { kind: "live" }>): void {
    st.root.classList.add("dm-call-panel--strip");
    const voice = voiceStore.getState();
    const first = v.inRoom[0];
    const status =
      v.inRoom.length === 1 && first !== undefined
        ? d("liveOne", { name: resolvePerson(first, v.dm, voice, currentUserId()).name })
        : d("liveMany", { count: v.inRoom.length });
    const row = createElement("div", { class: "dcp-row" });
    const faces = createElement("div", { class: "dcp-faces" });
    for (const id of v.inRoom) faces.appendChild(avatar(id, v.dm, "sm"));
    for (const id of absentMembers(v.dm, v.inRoom)) {
      faces.appendChild(avatar(id, v.dm, "sm", ABSENT_CLASS));
    }
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
      () => st.options.onJoin(v.dm.channelId),
      "phone",
    );
    appendChildren(row, faces, text, join);
    appendChildren(st.body, topBar(status, "", false), row);
  }

  function renderOutgoing(v: Extract<DmCallView, { kind: "outgoing" }>): void {
    if (st.collapsed) {
      renderCollapsed(v.dm, [currentUserId()], d("calling"));
      return;
    }
    st.root.classList.add("dm-call-panel--expanded");
    const me = currentUserId();
    const callees =
      v.pending.length > 0 ? v.pending : v.dm.participants.map((p) => p.id).slice(0, 1);
    const absent = absentMembers(v.dm, [me, ...callees]);
    let stage: HTMLElement;
    if (st.videoActive) {
      stage = videoStage(v.dm, [me, ...callees], callees, absent);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      stage.appendChild(person(me, v.dm));
      for (const id of callees) stage.appendChild(person(id, v.dm, "dcp-avatar--ringing"));
      for (const id of absent) stage.appendChild(person(id, v.dm, ABSENT_CLASS));
    }
    fill(
      topBar(d("calling"), "warn", true, true),
      stage,
      ...caption(d("callingName", { name: callName(v.dm, currentUserId()) }), d("ringingHint")),
      callControls(false),
    );
  }

  function renderUnanswered(v: Extract<DmCallView, { kind: "unanswered" }>): void {
    st.root.classList.add("dm-call-panel--expanded");
    const name = callName(v.dm, currentUserId());
    // Nobody else is in the room (deriveCallView hands us "unanswered" only
    // then), so the absent callee has no tile: showing their placeholder would
    // look like they joined. Ring again restores the ringing tile.
    // A group still lists its members, greyed out: they are not in the call.
    const ids = [currentUserId()];
    const absent = absentMembers(v.dm, ids);
    let stage: HTMLElement;
    if (st.videoActive) {
      stage = videoStage(v.dm, ids, [], absent);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      for (const id of ids) stage.appendChild(person(id, v.dm));
      for (const id of absent) stage.appendChild(person(id, v.dm, ABSENT_CLASS));
    }
    const actions = createElement("div", { class: "dcp-controls" });
    appendChildren(
      actions,
      textButton(d("ringAgain"), "btn-primary dcp-pill", "dcp-ring-again", () =>
        st.options.onRingAgain(v.dm.channelId),
      ),
      textButton(d("leave"), "btn-ghost dcp-pill", "dcp-leave-call", st.options.onLeave),
    );
    fill(
      topBar(unansweredText(v.reason, name, true), "bad", true),
      stage,
      ...caption(unansweredText(v.reason, name, false), d("stillInCall", { name })),
      actions,
    );
  }

  function renderConnected(v: Extract<DmCallView, { kind: "connected" }>): void {
    const status = headerStatusText(voiceStore.getState().voiceStatus);
    if (st.collapsed) {
      renderCollapsed(v.dm, v.inRoom, status);
      return;
    }
    st.root.classList.add("dm-call-panel--expanded");
    const absent = absentMembers(v.dm, v.inRoom);
    let stage: HTMLElement;
    if (st.videoActive) {
      stage = videoStage(v.dm, v.inRoom, [], absent);
    } else {
      stage = createElement("div", { class: "dcp-stage" });
      for (const id of v.inRoom) stage.appendChild(person(id, v.dm));
      for (const id of absent) stage.appendChild(person(id, v.dm, ABSENT_CLASS));
    }
    if (!v.canRingAgain) {
      fill(topBar(status, "", true, true), stage, callControls(false));
      return;
    }
    // The other person hung up, or a group member is missing: offer the redial,
    // as for an unanswered ring (a group re-rings everyone).
    const ringAgain = textButton(d("ringAgain"), "btn-primary dcp-pill", "dcp-ring-again", () =>
      st.options.onRingAgain(v.dm.channelId),
    );
    const controlsEl = callControls(false);
    controlsEl.prepend(ringAgain);
    fill(
      topBar(connectedStatus(v, voiceStore.getState().voiceStatus), "", true, true),
      stage,
      controlsEl,
    );
  }

  function renderCollapsed(dm: DmChannel, ids: readonly number[], status: string): void {
    st.root.classList.add("dm-call-panel--collapsed");
    const row = createElement("div", { class: "dcp-row" });
    const faces = createElement("div", { class: "dcp-faces" });
    for (const id of ids) faces.appendChild(avatar(id, dm, "sm"));
    const text = createElement("div", { class: "dcp-row-text" });
    st.statusEl = createElement("b", { class: "dcp-status" }, status);
    const timer = createElement("span", { class: "dcp-timer" }, "00:00");
    st.timerEls.push(timer);
    st.speakingEl = createElement("span", { class: "dcp-speaking" });
    appendChildren(text, st.statusEl, " · ", timer, st.speakingEl);
    const ctrl = callControls(true);
    ctrl.classList.add("dcp-controls--compact");
    appendChildren(row, faces, text, ctrl, collapseButton());
    st.body.appendChild(row);
  }

  return {
    avatar,
    person,
    roundButton,
    textButton,
    callControls,
    collapseButton,
    topBar,
    videoStage,
    fill,
    renderIncoming,
    renderLive,
    renderOutgoing,
    renderUnanswered,
    renderConnected,
    renderCollapsed,
  };
}
