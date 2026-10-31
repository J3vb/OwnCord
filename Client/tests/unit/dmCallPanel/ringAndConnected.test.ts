import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/dmCallPanelMocks";
import { absentMembers, deriveCallView } from "../../../src/features/direct-messages/DmCallPanel";
import {
  voiceStore,
  setPeerVerification,
  clearPeerVerification,
  type VoiceUser,
} from "../../../src/stores/voice.store";
import { openIdentityMismatchModal } from "../../../src/features/voice/peerVerification";
import {
  membersStore,
  updateMemberProfile,
  updatePresence,
} from "../../../src/stores/members.store";
import { setConnectionStatus, uiStore } from "../../../src/stores/ui.store";
import type { RingState, OutgoingCallState } from "../../../src/lib/voice/callRing";
import { cascadedDeclaration, keyword } from "../../helpers/app-css";
import {
  SELF,
  OTTO,
  DM,
  dm,
  vu,
  CARA,
  DAN,
  member,
  ring,
  setVoice,
  patchVoice,
  panel,
  mount,
  q,
  shield,
  timer,
} from "../../helpers/dmCallPanelHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/peerVerification", (importOriginal) =>
  mocks.voicePeerVerificationMock(importOriginal),
);

// ---------------------------------------------------------------------------
// deriveCallView — the whole "which panel" decision
// ---------------------------------------------------------------------------

describe("deriveCallView", () => {
  const base = {
    activeChannelId: DM as number | null,
    dms: [dm()],
    voice: { currentChannelId: null as number | null, voiceUsers: new Map() },
    selfId: SELF,
    incoming: null as RingState | null,
    outgoing: null as OutgoingCallState | null,
  };
  const room = (...ids: number[]) =>
    new Map([[DM, new Map(ids.map((id) => [id, vu(id)]))]]) as ReadonlyMap<
      number,
      ReadonlyMap<number, VoiceUser>
    >;

  it("shows nothing outside a DM, or in a quiet DM", () => {
    expect(deriveCallView({ ...base, activeChannelId: 7 }).kind).toBe("none");
    expect(deriveCallView({ ...base, activeChannelId: null }).kind).toBe("none");
    expect(deriveCallView(base).kind).toBe("none");
  });

  it("answers a ring for the open DM, but not a ring for another one", () => {
    expect(deriveCallView({ ...base, incoming: ring }).kind).toBe("incoming");
    expect(deriveCallView({ ...base, incoming: { ...ring, channelId: 101 } }).kind).toBe("none");
  });

  it("is a live strip when others are in the room and you are not", () => {
    const v = deriveCallView({
      ...base,
      voice: { currentChannelId: 7, voiceUsers: room(OTTO) },
    });
    expect(v).toMatchObject({ kind: "live", inRoom: [OTTO], otherChannelId: 7 });
  });

  it("is the outgoing ring while you are alone in the room and ringing", () => {
    const v = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF) },
      outgoing: { channelId: DM, phase: "ringing", pending: [OTTO] },
    });
    expect(v).toMatchObject({ kind: "outgoing", pending: [OTTO] });
  });

  it("reports a decline or no answer while you are still alone", () => {
    const voice = { currentChannelId: DM, voiceUsers: room(SELF) };
    expect(
      deriveCallView({
        ...base,
        voice,
        outgoing: { channelId: DM, phase: "declined", pending: [] },
      }),
    ).toMatchObject({ kind: "unanswered", reason: "declined" });
    expect(
      deriveCallView({
        ...base,
        voice,
        outgoing: { channelId: DM, phase: "no-answer", pending: [OTTO] },
      }),
    ).toMatchObject({ kind: "unanswered", reason: "no-answer" });
  });

  it("reports an offline callee as unanswered at once", () => {
    expect(
      deriveCallView({
        ...base,
        voice: { currentChannelId: DM, voiceUsers: room(SELF) },
        outgoing: { channelId: DM, phase: "offline", pending: [OTTO] },
      }),
    ).toMatchObject({ kind: "unanswered", reason: "offline" });
  });

  it("is connected as soon as anyone else is in the room, whatever the ring said", () => {
    const v = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF, OTTO) },
      outgoing: { channelId: DM, phase: "ringing", pending: [OTTO] },
    });
    expect(v).toMatchObject({ kind: "connected", inRoom: [SELF, OTTO] });
  });

  it("keeps a connected view, flagged, when the only other person has left", () => {
    const v = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF) },
      peerWasHere: true,
    });
    expect(v).toMatchObject({ kind: "connected", inRoom: [SELF], peerLeft: true });
    const fresh = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF) },
    });
    expect(fresh).toMatchObject({ kind: "connected", peerLeft: false });
    const group = deriveCallView({
      ...base,
      dms: [dm({ isGroup: true })],
      voice: { currentChannelId: DM, voiceUsers: room(SELF) },
      peerWasHere: true,
    });
    expect(group).toMatchObject({ kind: "connected", peerLeft: false, canRingAgain: true });
  });

  it("offers Ring again in a group whenever a member is not in the room (3B-8)", () => {
    const groupDm = dm({
      isGroup: true,
      participants: [OTTO, CARA].map((id) => member(id)),
    });
    const input = { ...base, dms: [groupDm] };
    const missing = deriveCallView({
      ...input,
      voice: { currentChannelId: DM, voiceUsers: room(SELF, OTTO) },
    });
    expect(missing).toMatchObject({ kind: "connected", peerLeft: false, canRingAgain: true });
    const full = deriveCallView({
      ...input,
      voice: { currentChannelId: DM, voiceUsers: room(SELF, OTTO, CARA) },
    });
    expect(full).toMatchObject({ kind: "connected", canRingAgain: false });
    // A 1:1 is unchanged: only a peer who left earns the redial.
    const oneToOne = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF, OTTO) },
    });
    expect(oneToOne).toMatchObject({ kind: "connected", canRingAgain: false });
  });

  it("lists the group members who are not present, never for a 1:1", () => {
    const groupDm = dm({ isGroup: true, participants: [OTTO, CARA, DAN].map((id) => member(id)) });
    expect(absentMembers(groupDm, [SELF, CARA])).toEqual([OTTO, DAN]);
    expect(absentMembers(dm(), [SELF])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe("DmCallPanel — incoming ring", () => {
  it("is the answer surface for the open DM: Accept, Join with video, Decline", () => {
    const { opts, root } = mount();
    panel!.setIncoming(ring);

    expect(root.hidden).toBe(false);
    expect(root.dataset.state).toBe("incoming");
    expect(root.getAttribute("aria-label")).toBe("Call with Otto");
    expect(q(root, "dcp-caption")!.textContent).toBe("Otto is calling…");
    expect(panel!.showsRingFor(DM)).toBe(true);
    expect(panel!.showsRingFor(101)).toBe(false);

    q(root, "dcp-accept")!.click();
    q(root, "dcp-accept-video")!.click();
    q(root, "dcp-decline")!.click();
    expect(opts.onAccept.mock.calls).toEqual([[false], [true]]);
    expect(opts.onDecline).toHaveBeenCalledTimes(1);
  });

  it("says the ring in a polite live region present from mount", () => {
    const { root } = mount();
    const live = root.querySelector("[data-testid='dm-call-live']")!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("");

    panel!.setIncoming(ring);
    expect(live.textContent).toBe("Otto is calling…");
  });

  it("hides again when the ring ends", () => {
    const { root } = mount();
    panel!.setIncoming(ring);
    panel!.setIncoming(null);
    expect(root.hidden).toBe(true);
    expect(panel!.showsRingFor(DM)).toBe(false);
  });
});

describe("DmCallPanel — caller side", () => {
  it("shows the outgoing ring with the callee dimmed and pulsing", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });

    expect(root.dataset.state).toBe("outgoing");
    expect(q(root, "dcp-caption")!.textContent).toBe("Calling Otto…");
    const callee = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;
    expect(callee.classList.contains("dcp-avatar--ringing")).toBe(true);
    expect(q(root, "dcp-leave")).not.toBeNull();
  });

  it("after a decline offers Ring again and Leave call, and says what happened", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "declined", pending: [] });

    expect(q(root, "dcp-caption")!.textContent).toBe("Otto declined the call");
    expect(root.querySelector("[data-testid='dm-call-live']")!.textContent).toBe(
      "Otto declined the call",
    );
    q(root, "dcp-ring-again")!.click();
    q(root, "dcp-leave-call")!.click();
    expect(opts.onRingAgain).toHaveBeenCalledWith(DM);
    expect(opts.onLeave).toHaveBeenCalledTimes(1);
  });

  it("names a missed call as no answer", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO] });
    expect(q(root, "dcp-caption")!.textContent).toBe("Otto didn't answer");
  });

  it("says an offline callee is offline, with Ring again and Leave call", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "offline", pending: [OTTO] });

    expect(root.dataset.state).toBe("unanswered");
    expect(q(root, "dcp-caption")!.textContent).toBe("Otto is offline");
    expect(root.querySelector(".dcp-status")!.textContent).toBe("Otto is offline");
    expect(root.querySelector("[data-testid='dm-call-live']")!.textContent).toBe("Otto is offline");
    expect(root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)).toBeNull();
    q(root, "dcp-ring-again")!.click();
    expect(opts.onRingAgain).toHaveBeenCalledWith(DM);
    expect(q(root, "dcp-leave-call")).not.toBeNull();
  });

  it("drops the callee's tile once the call went unanswered, keeping both actions", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO] });

    expect(root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)).toBeNull();
    expect(root.querySelector(`.dcp-avatar[data-user-id='${SELF}']`)).not.toBeNull();
    expect(q(root, "dcp-ring-again")).not.toBeNull();
    expect(q(root, "dcp-leave-call")).not.toBeNull();
  });

  it("puts the callee's ringing tile back when Ring again starts a new ring", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO] });
    expect(root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)).toBeNull();

    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });

    const callee = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;
    expect(callee).not.toBeNull();
    expect(callee.classList.contains("dcp-avatar--ringing")).toBe(true);
  });

  it("offers no Collapse once the call went unanswered, only while ringing", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    expect(q(root, "dcp-collapse")).not.toBeNull();

    panel!.setOutgoing({ channelId: DM, phase: "declined", pending: [] });
    expect(q(root, "dcp-collapse")).toBeNull();
    expect(q(root, "dcp-secured")).not.toBeNull();
  });
});

describe("DmCallPanel — live call you are not in", () => {
  it("offers Join call", () => {
    setVoice(null, [vu(OTTO)]);
    const { opts, root } = mount();

    expect(root.dataset.state).toBe("live");
    expect(root.textContent).toContain("Otto is in a call");
    const join = q(root, "dcp-join")!;
    expect(join.textContent).toBe("Join call");
    join.click();
    expect(opts.onJoin).toHaveBeenCalledWith(DM);
  });

  it("says Switch to this call, and names the channel you would leave", () => {
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 7,
      voiceUsers: new Map([
        [DM, new Map([[OTTO, vu(OTTO)]])],
        [7, new Map([[SELF, vu(SELF)]])],
      ]),
    }));
    voiceStore.flush();
    const { root } = mount();

    expect(q(root, "dcp-join")!.textContent).toBe("Switch to this call");
    expect(root.textContent).toContain("Joining leaves Lobby.");
  });
});

describe("DmCallPanel — connected", () => {
  it("draws everyone in the room and wires the call controls", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();

    expect(root.dataset.state).toBe("connected");
    expect(root.querySelectorAll(".dcp-person")).toHaveLength(2);
    expect(root.querySelector("[role='toolbar']")!.getAttribute("aria-label")).toBe(
      "Call controls",
    );
    for (const id of ["dcp-mute", "dcp-deafen", "dcp-camera", "dcp-share", "dcp-leave"]) {
      q(root, id)!.click();
    }
    expect(opts.onMuteToggle).toHaveBeenCalledTimes(1);
    expect(opts.onDeafenToggle).toHaveBeenCalledTimes(1);
    expect(opts.onCameraToggle).toHaveBeenCalledTimes(1);
    expect(opts.onScreenshareToggle).toHaveBeenCalledTimes(1);
    expect(opts.onLeave).toHaveBeenCalledTimes(1);
  });

  it("reflects the local state on the toggles and never by colour alone", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    patchVoice({ localMuted: true, localCamera: true });

    const mute = q(root, "dcp-mute")!;
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic-off");
    expect(q(root, "dcp-camera")!.getAttribute("aria-pressed")).toBe("true");
    const selfBadge = root.querySelector(`.dcp-avatar[data-user-id='${SELF}'] .dcp-avatar-badge`)!;
    expect((selfBadge as HTMLElement).hidden).toBe(false);
    expect(selfBadge.getAttribute("title")).toBe("Muted");
  });

  it("shows a listen-only join's mic as off and inert, not a live mic", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root, opts } = mount();
    patchVoice({ listenOnly: true, localMuted: false });

    const mute = q(root, "dcp-mute")!;
    expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic-off");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(mute.disabled).toBe(true);
    expect(mute.title).toBe("Listening only — no microphone access");
    expect(keyword(cascadedDeclaration(".dcp-btn:disabled", "opacity"))).toBe("0.5");
    mute.click();
    expect(opts.onMuteToggle).not.toHaveBeenCalled();

    // A granted microphone makes it a live control again.
    patchVoice({ listenOnly: false });
    expect(mute.disabled).toBe(false);
    expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic");
  });

  it("does not read a push-to-talk user as muted between presses", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    // Push-to-talk gates inside the mic processor and never writes localMuted.
    patchVoice({ localMuted: false, pttGated: true });

    const mute = q(root, "dcp-mute")!;
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic");
    const selfBadge = root.querySelector(`.dcp-avatar[data-user-id='${SELF}'] .dcp-avatar-badge`)!;
    expect((selfBadge as HTMLElement).hidden).toBe(true);

    // The user's own mute, key up, still reads muted.
    patchVoice({ localMuted: true });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic-off");
  });

  it("keeps a moderator mute and a dropped socket out of reach, but never Leave", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    patchVoice({ localServerMuted: true });
    expect(q(root, "dcp-mute")!.disabled).toBe(true);
    expect(q(root, "dcp-deafen")!.disabled).toBe(false);

    setConnectionStatus("reconnecting");
    uiStore.flush();
    for (const id of ["dcp-camera", "dcp-share"]) {
      expect(q(root, id)!.disabled).toBe(true);
    }
    // Mute and deafen apply locally and are restated on reconnect, so only a
    // moderator's restriction keeps them out of reach.
    expect(q(root, "dcp-deafen")!.disabled).toBe(false);
    expect(q(root, "dcp-mute")!.disabled).toBe(true);
    expect(q(root, "dcp-leave")!.disabled).toBe(false);

    patchVoice({ localServerMuted: false });
    expect(q(root, "dcp-mute")!.disabled).toBe(false);
  });

  it("updates the speaking ring in place, without redrawing the avatar", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    const before = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;

    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    const after = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;
    expect(after).toBe(before);
    expect(after.classList.contains("dcp-avatar--speaking")).toBe(true);
  });

  it("redraws avatars on a rename, but not on someone's presence flip", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    const before = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;

    updatePresence(OTTO, "idle");
    membersStore.flush();
    expect(root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)).toBe(before);

    updateMemberProfile(OTTO, { username: "otheruser", avatar: null, displayName: "Otto II" });
    membersStore.flush();
    const renamed = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;
    expect(renamed).not.toBe(before);
    expect(root.textContent).toContain("Otto II");
  });

  it("keeps keyboard focus on the same control when the stage is redrawn", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    q(root, "dcp-mute")!.focus();

    setVoice(DM, [vu(SELF), vu(OTTO)]);
    expect(root.querySelectorAll(".dcp-person")).toHaveLength(2);
    expect(document.activeElement).toBe(q(root, "dcp-mute"));
  });

  it("collapses to one row that says who is speaking, and expands again", () => {
    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    const { root } = mount();
    const collapse = q(root, "dcp-collapse")!;
    collapse.focus();
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    collapse.click();

    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
    expect(root.textContent).toContain("Otto is speaking");
    expect(q(root, "dcp-mute")).not.toBeNull();
    const expand = q(root, "dcp-collapse")!;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-label")).toBe("Expand call");
    expect(document.activeElement).toBe(expand);

    expand.click();
    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);
  });

  it("goes away when you leave a call nobody else is in", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    expect(root.hidden).toBe(false);
    setVoice(null, []);
    expect(root.hidden).toBe(true);
  });
});

describe("DmCallPanel — after the other person leaves", () => {
  it("says who left and offers Ring again once you are alone again", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    expect(q(root, "dcp-ring-again")).toBeNull();

    setVoice(DM, [vu(SELF)]);
    expect(root.dataset.state).toBe("connected");
    expect(root.textContent).toContain("Otto left the call");
    q(root, "dcp-ring-again")!.click();
    expect(opts.onRingAgain).toHaveBeenCalledWith(DM);
  });
});

describe("DmCallPanel — peer identity verification", () => {
  it("shows each peer's shield in the call as it resolves, and none for you", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(shield(root, OTTO)).toBeNull();

    setPeerVerification({
      userId: OTTO,
      status: "verified",
      safetyNumber: "1234 5678",
      sessionFingerprint: "ab:cd",
    });
    voiceStore.flush();
    const badge = shield(root, OTTO)!;
    expect(badge.querySelector("svg")!.getAttribute("data-icon")).toBe("shield-check");
    expect(badge.title).toBe(
      "Same key as before · Safety number: 1234 5678 · Compare it with them to confirm it is them",
    );
    expect(badge.tagName).toBe("SPAN");
    expect(shield(root, SELF)).toBeNull();
  });

  it("a blocked peer shows a red shield whose button opens the re-trust prompt", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();

    const badge = shield(root, OTTO)!;
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.classList.contains("mismatch")).toBe(true);
    expect(badge.querySelector("svg")!.getAttribute("data-icon")).toBe("shield-alert");
    expect(badge.getAttribute("aria-label")).toContain("Blocked");
    badge.click();
    expect(openIdentityMismatchModal).toHaveBeenCalledWith(
      OTTO,
      "Otto",
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("hands the re-trust modal a focus fallback that lands on the replacement shield", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    document.body.appendChild(root);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    shield(root, OTTO)!.click();
    const fallback = vi.mocked(openIdentityMismatchModal).mock.calls.at(-1)![3]!;

    // The modal holds focus while Trust New Key lands the new verification.
    const trust = document.body.appendChild(document.createElement("button"));
    trust.focus();
    setPeerVerification({
      userId: OTTO,
      status: "verified",
      safetyNumber: "1234 5678",
      sessionFingerprint: "ab:cd",
    });
    voiceStore.flush();
    trust.remove();
    fallback()!.focus();
    expect(document.activeElement).toBe(shield(root, OTTO));

    clearPeerVerification(OTTO);
    voiceStore.flush();
    fallback()!.focus();
    expect(document.activeElement).not.toBe(document.body);
    root.remove();
  });
});

describe("DmCallPanel — call timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts from when the other person joined, so both sides show the same length", () => {
    vi.useFakeTimers();
    // The caller joins and rings for 5 s before the callee answers.
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    vi.advanceTimersByTime(5000);
    expect(timer(root)).toBe("00:00");

    panel!.setOutgoing(null);
    patchVoice({
      voiceUsers: new Map([[DM, new Map([vu(SELF), vu(OTTO)].map((u) => [u.userId, u]))]]),
    });
    vi.advanceTimersByTime(3000);
    // The callee, who joined 5 s later, sees 00:03 too.
    expect(timer(root)).toBe("00:03");
  });
});

describe("DmCallPanel — controls while the call connects", () => {
  it("disables camera and share until the voice session is connected", () => {
    setVoice(DM, [vu(SELF)]);
    patchVoice({ voiceStatus: "joining" });
    const { opts, root } = mount();
    expect(q(root, "dcp-camera")!.disabled).toBe(true);
    expect(q(root, "dcp-share")!.disabled).toBe(true);
    expect(q(root, "dcp-camera")!.title).toBe("Connecting…");

    patchVoice({ voiceStatus: "connected" });
    expect(q(root, "dcp-camera")!.disabled).toBe(false);
    expect(q(root, "dcp-share")!.disabled).toBe(false);
    q(root, "dcp-camera")!.click();
    expect(opts.onCameraToggle).toHaveBeenCalledTimes(1);
  });

  it("disables share with the reason when the grant leaves screen share out", () => {
    setVoice(DM, [vu(SELF)]);
    patchVoice({ voiceStatus: "connected", shareDenied: true });
    const { root } = mount();
    expect(q(root, "dcp-share")!.disabled).toBe(true);
    expect(q(root, "dcp-share")!.title).toBe("You don't have permission to share your screen here");
    expect(q(root, "dcp-camera")!.disabled).toBe(false);

    patchVoice({ shareDenied: false });
    expect(q(root, "dcp-share")!.disabled).toBe(false);
  });
});
