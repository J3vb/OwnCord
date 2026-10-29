import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The panel reuses the voice widget's status text, which pulls in the voice
// session facade; nothing here touches a real session.
vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/features/voice/peerVerification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/voice/peerVerification")>()),
  openIdentityMismatchModal: vi.fn().mockResolvedValue(undefined),
}));

import {
  absentMembers,
  createDmCallPanel,
  deriveCallView,
  type DmCallPanelComponent,
  type DmCallPanelOptions,
} from "../../src/components/DmCallPanel";
import {
  voiceStore,
  setPeerVerification,
  clearPeerVerifications,
  setLocalSafetyNumber,
  setLocalSessionFingerprint,
  clearPeerVerification,
  type VoiceUser,
} from "../../src/stores/voice.store";
import { openIdentityMismatchModal } from "../../src/features/voice/peerVerification";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import { membersStore, updateMemberProfile, updatePresence } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { setConnectionStatus, uiStore } from "../../src/stores/ui.store";
import type { RingState, OutgoingCallState } from "../../src/lib/call-ring";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

const SELF = 1;
const OTTO = 2;
const DM = 100;

const dm = (overrides: Partial<DmChannel> = {}): DmChannel => ({
  channelId: DM,
  recipient: { id: OTTO, username: "otheruser", avatar: "", status: "online" },
  participants: [{ id: OTTO, username: "otheruser", avatar: "", status: "online" }],
  name: "",
  isGroup: false,
  lastMessageId: null,
  lastMessage: "",
  lastMessageAt: "",
  unreadCount: 0,
  mentionCount: 0,
  ...overrides,
});

const vu = (userId: number, extra: Partial<VoiceUser> = {}): VoiceUser => ({
  userId,
  username: userId === SELF ? "me" : "otheruser",
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare: false,
  ...extra,
});

const CARA = 3;
const DAN = 4;
const member = (id: number, name = `user${id}`): DmChannel["participants"][number] => ({
  id,
  username: name,
  avatar: "",
  status: "online",
});

const ring: RingState = { channelId: DM, fromUserId: OTTO, fromUsername: "Otto" };

function setVoice(currentChannelId: number | null, users: VoiceUser[], channelId = DM): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId,
    voiceUsers: new Map([[channelId, new Map(users.map((u) => [u.userId, u]))]]),
    joinedAt: currentChannelId === null ? null : Date.now(),
  }));
  voiceStore.flush();
}

function patchVoice(patch: Partial<ReturnType<typeof voiceStore.getState>>): void {
  voiceStore.setState((prev) => ({ ...prev, ...patch }));
  voiceStore.flush();
}

type MockedOptions = {
  [K in keyof DmCallPanelOptions]-?: K extends "videoGrid"
    ? { setPeople: ReturnType<typeof vi.fn> }
    : ReturnType<typeof vi.fn>;
};

function options(): MockedOptions {
  return {
    onMuteToggle: vi.fn(),
    onDeafenToggle: vi.fn(),
    onCameraToggle: vi.fn(),
    onScreenshareToggle: vi.fn(),
    onLeave: vi.fn(),
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onJoin: vi.fn(),
    onRingAgain: vi.fn(),
    onVideoHostChange: vi.fn(),
    videoGrid: { setPeople: vi.fn() },
  };
}

let host: HTMLDivElement;
let panel: DmCallPanelComponent | null = null;

function mount(opts = options()): { opts: MockedOptions; root: HTMLElement } {
  panel = createDmCallPanel(opts as unknown as DmCallPanelOptions);
  panel.mount(host);
  const root = host.querySelector<HTMLElement>("[data-testid='dm-call-panel']")!;
  return { opts, root };
}

/** Stand in for the shared grid hosting the avatar tiles the panel hands it. */
function hostAvatars(opts: MockedOptions): void {
  const hostEl = panel!.videoElement()!;
  const calls = opts.videoGrid.setPeople.mock.calls;
  const people = calls[calls.length - 1]![0] as { content: HTMLElement }[];
  for (const p of people) hostEl.appendChild(p.content);
}

const q = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);

const shield = (root: HTMLElement, id: number) =>
  root.querySelector<HTMLElement>(`.dcp-avatar[data-user-id='${id}'] .dcp-verify`);
// Wherever it sits: on the avatar, or on a camera tile in the grid.
const anyShield = (root: HTMLElement) => root.querySelector<HTMLElement>(".dcp-verify");
const timer = (root: HTMLElement) => root.querySelector(".dcp-timer")!.textContent;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  authStore.setState(() => ({
    token: "t",
    user: { id: SELF, username: "me", avatar: null, role: "member" },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
  membersStore.setState(() => ({
    members: new Map([
      [
        OTTO,
        {
          id: OTTO,
          username: "otheruser",
          displayName: "Otto",
          avatar: null,
          role: "member",
          status: "online" as const,
        },
      ],
    ]),
    typingUsers: new Map(),
  }));
  dmStore.setState(() => ({ channels: [dm()] }));
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map([
      [
        7,
        {
          id: 7,
          name: "Lobby",
          type: "voice" as const,
          category: null,
          topic: "",
          position: 0,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageId: null,
          canSend: true,
          slowMode: 0,
          nsfw: false,
          isPrivate: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        },
      ],
    ]),
    activeChannelId: DM,
    roles: [],
  }));
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: null,
    voiceUsers: new Map(),
    localMuted: false,
    localDeafened: false,
    localServerMuted: false,
    localServerDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    voiceStatus: "idle",
  }));
  setConnectionStatus("connected");
  for (const s of [authStore, membersStore, dmStore, channelsStore, voiceStore]) s.flush();
});

afterEach(() => {
  clearPeerVerifications();
  setLocalSafetyNumber(null);
  setLocalSessionFingerprint(null);
  voiceStore.flush();
  panel?.destroy?.();
  panel = null;
  host.remove();
});

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

describe("DmCallPanel — video in the call", () => {
  type Person = { userId: number; label: string; content: HTMLElement };
  const lastPeople = (opts: MockedOptions): Person[] =>
    (opts.videoGrid.setPeople.mock.calls.at(-1)?.[0] as Person[] | undefined) ?? [];

  it("owns the call it is showing, and only that one", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    mount();
    expect(panel!.ownsCall(DM)).toBe(true);
    expect(panel!.ownsCall(7)).toBe(false);
  });

  it("does not own a call you are not in", () => {
    setVoice(null, [vu(OTTO)]);
    mount();
    expect(panel!.ownsCall(DM)).toBe(false);
    expect(panel!.videoElement()).toBeNull();
  });

  it("makes room for the grid in its stage while video is on, with the chat left alone", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    const el = panel!.videoElement()!;
    expect(el).not.toBeNull();
    expect(root.contains(el)).toBe(false);

    panel!.setVideoActive(true);

    expect(root.contains(el)).toBe(true);
    expect(root.classList.contains("dm-call-panel--video")).toBe(true);
    expect(root.querySelector(".dcp-stage")).toBeNull();
    // The call controls stay under the video.
    expect(q(root, "dcp-mute")).not.toBeNull();
  });

  it("hands the grid an avatar tile for everyone in the call, kept live in place", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts } = mount();
    panel!.setVideoActive(true);

    const people = lastPeople(opts);
    expect(people.map((p) => [p.userId, p.label])).toEqual([
      [SELF, "You"],
      [OTTO, "Otto"],
    ]);
    const otto = people[1]!.content;
    expect(otto.classList.contains("dcp-avatar")).toBe(true);

    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    expect(otto.classList.contains("dcp-avatar--speaking")).toBe(true);
  });

  it("keeps keyboard focus on a control inside the video when someone joins", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setVideoActive(true);
    const slider = document.createElement("input");
    slider.type = "range";
    panel!.videoElement()!.appendChild(slider);
    slider.focus();

    setVoice(DM, [vu(SELF), vu(OTTO)]);

    expect(root.contains(slider)).toBe(true);
    expect(document.activeElement).toBe(slider);
  });

  it("never moves the video when someone joins or leaves, so a full-screen tile stays", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setVideoActive(true);
    const el = panel!.videoElement()!;
    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true, subtree: true });

    setVoice(DM, [vu(SELF), vu(OTTO)]);
    setVoice(DM, [vu(SELF)]);

    const removed = observer.takeRecords().flatMap((r) => [...r.removedNodes]);
    observer.disconnect();
    expect(removed).not.toContain(el);
    expect(root.contains(el)).toBe(true);
    // The call controls stay under the video.
    expect(
      el.compareDocumentPosition(q(root, "dcp-mute")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("gives the grid nobody once video goes off", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    panel!.setVideoActive(false);

    expect(lastPeople(opts)).toEqual([]);
    expect(root.querySelector(".dcp-stage")).not.toBeNull();
  });

  it("collapsed, it shows no video and never expands on its own; Expand shows it", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    q(root, "dcp-collapse")!.click();
    opts.onVideoHostChange.mockClear();

    panel!.setVideoActive(true);
    expect(panel!.videoElement()).toBeNull();
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
    expect(q(root, "dcp-watch")).toBeNull();

    q(root, "dcp-collapse")!.click();

    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);
    expect(root.contains(panel!.videoElement())).toBe(true);
    expect(opts.onVideoHostChange).toHaveBeenCalled();
  });

  it("shows your own video while the call is still ringing, with the ring caption kept", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    const el = panel!.videoElement()!;
    expect(el).not.toBeNull();

    panel!.setVideoActive(true);

    expect(root.contains(el)).toBe(true);
    expect(root.classList.contains("dm-call-panel--video")).toBe(true);
    expect(q(root, "dcp-caption")!.textContent).toBe("Calling Otto…");
    expect(q(root, "dcp-camera")).not.toBeNull();
    const people = lastPeople(opts);
    expect(people.map((p) => p.userId)).toEqual([SELF, OTTO]);
    expect(people[0]!.content.classList.contains("dcp-avatar--ringing")).toBe(false);
    expect(people[1]!.content.classList.contains("dcp-avatar--ringing")).toBe(true);
  });

  it("shows your own safety number on your own shield while you are in the call", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    hostAvatars(opts);
    expect(shield(root, SELF)).toBeNull();

    patchVoice({ localSafetyNumber: "AB12 CD34", localSessionFingerprint: "5E55 1234" });
    const own = shield(root, SELF)!;
    expect(own).not.toBeNull();
    expect(own.tagName).toBe("SPAN");
    expect(own.title).toContain("Your safety number: AB12 CD34");
    expect(own.title).toContain("5E55 1234");
    expect(own.getAttribute("aria-label")).toBe(own.title);

    // A new session's numbers redraw it; leaving the session removes it.
    patchVoice({ localSafetyNumber: "FFFF 0000" });
    expect(shield(root, SELF)!.title).toContain("FFFF 0000");
    patchVoice({ localSafetyNumber: null, localSessionFingerprint: null });
    expect(shield(root, SELF)).toBeNull();
  });

  it("shows no own shield when the numbers belong to another call", () => {
    const elsewhere = 555;
    setVoice(elsewhere, [vu(SELF)], elsewhere);
    patchVoice({ localSafetyNumber: "AB12 CD34", localSessionFingerprint: "5E55 1234" });
    const { root } = mount();
    panel!.setIncoming(ring);
    patchVoice({ localSafetyNumber: "AB12 CD35" });
    expect(shield(root, SELF)).toBeNull();
  });

  it("moves a blocked peer's shield with their camera tile, and back when it goes", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const onAvatar = shield(root, OTTO)!;
    expect(onAvatar).not.toBeNull();

    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    const badge = cell.querySelector<HTMLElement>(".dcp-verify")!;
    expect(badge).toBe(onAvatar);
    expect(badge.tagName).toBe("BUTTON");
    badge.click();
    expect(openIdentityMismatchModal).toHaveBeenCalledWith(
      OTTO,
      "Otto",
      expect.any(AbortSignal),
      expect.any(Function),
    );

    cell.remove();
    await Promise.resolve();
    expect(shield(root, OTTO)).toBe(badge);
  });

  it("keeps focus on a focused shield when its camera tile is swapped away", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    document.body.appendChild(root);
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    const badge = anyShield(root)!;
    badge.focus();
    expect(document.activeElement).toBe(badge);
    cell.remove();
    await Promise.resolve();

    expect(document.activeElement).toBe(anyShield(root));
    root.remove();
  });

  it("does not steal focus back after the shield was blurred and the grid mutates", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    document.body.appendChild(root);
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    anyShield(root)!.focus();
    anyShield(root)!.blur();
    cell.appendChild(document.createElement("span"));
    await Promise.resolve();

    expect(document.activeElement).toBe(document.body);
    root.remove();
  });

  it("refocuses the shield when blur fires before its tile is detached", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    document.body.appendChild(root);
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    const badge = anyShield(root)!;
    badge.focus();
    badge.dispatchEvent(new FocusEvent("blur"));
    cell.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(anyShield(root));

    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(anyShield(root));
    root.remove();
  });

  it("does not refocus a shield the panel itself replaced on rebuild", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    document.body.appendChild(root);
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    anyShield(root)!.focus();
    q(root, "dcp-collapse")!.click();
    q(root, "dcp-collapse")?.click();
    voiceStore.flush();
    await Promise.resolve();
    (document.activeElement as HTMLElement | null)?.blur();
    cell.remove();
    await Promise.resolve();

    expect(document.activeElement).toBe(document.body);
    root.remove();
  });

  it("leaves one shield on a camera tile across a panel rebuild", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    q(root, "dcp-collapse")!.click();
    q(root, "dcp-collapse")?.click();
    voiceStore.flush();
    await Promise.resolve();

    expect(cell.querySelectorAll(".dcp-verify")).toHaveLength(1);
  });

  it("keeps your own video once the call went unanswered, without the absent callee's tile", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "declined", pending: [] });
    panel!.setVideoActive(true);

    const people = lastPeople(opts);
    expect(people.map((p) => p.userId)).toEqual([SELF]);

    expect(root.contains(panel!.videoElement())).toBe(true);
    expect(q(root, "dcp-caption")!.textContent).toBe("Otto declined the call");
    expect(q(root, "dcp-ring-again")).not.toBeNull();
  });

  it("tells its owner when it can or cannot host video any more", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    opts.onVideoHostChange.mockClear();

    q(root, "dcp-collapse")!.click();
    expect(opts.onVideoHostChange).toHaveBeenCalledTimes(1);

    setVoice(null, []);
    expect(opts.onVideoHostChange).toHaveBeenCalledTimes(2);
  });
});

describe("DmCallPanel — resize", () => {
  const PREF = "owncord:settings:dmCallHeight";
  const box = (height: number) => ({ height }) as DOMRect;

  /** jsdom lays nothing out: a 1000px chat column, and a panel drawn at its
   *  dragged height (400px by default), never below `contentMin`. */
  function sized(root: HTMLElement, contentMin = 0): void {
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(1000));
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => {
      const dragged = parseFloat(root.style.getPropertyValue("--dcp-height"));
      return box(Math.max(contentMin, Number.isNaN(dragged) ? 400 : dragged));
    });
  }

  const pointer = (type: string, clientY: number) =>
    new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY });

  beforeEach(() => localStorage.removeItem(PREF));
  afterEach(() => localStorage.removeItem(PREF));

  it("drags the bottom edge, keeps room for the chat, and remembers the height", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;
    expect(handle.hidden).toBe(false);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 520));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("520px");
    // 1000px column less 120px kept for the messages.
    handle.dispatchEvent(pointer("pointermove", 2000));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("880px");
    expect(handle.getAttribute("aria-valuemax")).toBe("880");
    handle.dispatchEvent(pointer("pointermove", -500));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("160px");
    expect(localStorage.getItem(PREF)).toBeNull();
    handle.dispatchEvent(pointer("pointermove", 450));
    handle.dispatchEvent(pointer("pointerup", 450));
    expect(localStorage.getItem(PREF)).toBe("450");

    // A move without a press does nothing.
    handle.dispatchEvent(pointer("pointermove", 700));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("450px");

    panel!.destroy?.();
    const { root: again } = mount();
    expect(again.style.getPropertyValue("--dcp-height")).toBe("450px");
  });

  it("hides the handle and drops the height while collapsed", () => {
    localStorage.setItem(PREF, "300");
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(root.style.getPropertyValue("--dcp-height")).toBe("300px");

    q(root, "dcp-collapse")!.click();
    expect(q(root, "dcp-resize")!.hidden).toBe(true);
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");

    q(root, "dcp-collapse")!.click();
    expect(q(root, "dcp-resize")!.hidden).toBe(false);
    expect(root.style.getPropertyValue("--dcp-height")).toBe("300px");
  });

  it("resizes from the keyboard and double-click restores the default", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("424px");
    expect(handle.getAttribute("aria-valuenow")).toBe("424");
    expect(localStorage.getItem(PREF)).toBe("424");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("400px");

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");
    expect(localStorage.getItem(PREF)).toBe("0");
  });

  it("keeps the header and composer out of the room a drag can take", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const composer = document.createElement("div");
    host.appendChild(composer);
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(box(200));
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 2000));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("680px");
  });

  it("reports the drawn height on first show", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const original = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "dm-call-panel" && !this.hidden) return box(464);
        return original.call(this);
      });
    try {
      const { root } = mount();
      expect(q(root, "dcp-resize")!.getAttribute("aria-valuenow")).toBe("464");
    } finally {
      spy.mockRestore();
    }
  });

  it("never saves a height under what an audio-only panel draws", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root, 260);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 100));
    handle.dispatchEvent(pointer("pointerup", 100));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("260px");
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    expect(localStorage.getItem(PREF)).toBe("260");
  });

  it("ends a drag when the call collapses under it", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 500));
    q(root, "dcp-collapse")!.click();
    expect(localStorage.getItem(PREF)).toBe("500");
    handle.dispatchEvent(pointer("pointermove", 700));
    q(root, "dcp-collapse")!.click();
    expect(root.style.getPropertyValue("--dcp-height")).toBe("500px");
  });

  it("clamps the dragged height to the chat column in the stylesheet", () => {
    const height = cascadedDeclaration(".dm-call-panel--expanded", "height");
    expect(JSON.stringify(height)).toContain("dcp-height");
  });
});

describe("DmCallPanel — group roster (3B-8)", () => {
  const group = (): DmChannel =>
    dm({
      isGroup: true,
      name: "Trio",
      participants: [member(OTTO, "otto"), member(CARA, "cara"), member(DAN, "dan")],
    });
  const tile = (root: HTMLElement, id: number) =>
    root.querySelector<HTMLElement>(`.dcp-avatar[data-user-id='${id}']`)!;
  const ids = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".dcp-person .dcp-avatar")].map((e) =>
      Number(e.dataset.userId),
    );
  const greyed = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".dcp-avatar--absent")].map((e) =>
      Number(e.dataset.userId),
    );

  beforeEach(() => {
    dmStore.setState(() => ({ channels: [group()] }));
    dmStore.flush();
  });

  it("shows in-call members, then ringing, then the rest greyed out and labelled", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [CARA] });

    expect(root.dataset.state).toBe("outgoing");
    expect(ids(root)).toEqual([SELF, CARA, OTTO, DAN]);
    expect(tile(root, CARA).classList.contains("dcp-avatar--ringing")).toBe(true);
    expect(greyed(root)).toEqual([OTTO, DAN]);
    expect(tile(root, SELF).classList.contains("dcp-avatar--absent")).toBe(false);
    expect(root.querySelectorAll(".dcp-person--absent")).toHaveLength(2);
    expect(tile(root, OTTO).title).toBe("Not in call");
    expect(tile(root, OTTO).querySelector(".sr-only")!.textContent).toBe("Not in call");
  });

  it("greys out every other member once the ring went unanswered", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO, CARA, DAN] });

    expect(root.dataset.state).toBe("unanswered");
    expect(greyed(root)).toEqual([OTTO, CARA, DAN]);
  });

  it("moves a member from greyed to in-call when they join, and back when they leave", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(ids(root)).toEqual([SELF, OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([CARA, DAN]);

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA)]);
    expect(ids(root)).toEqual([SELF, OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([DAN]);

    setVoice(DM, [vu(SELF), vu(CARA)]);
    expect(ids(root)).toEqual([SELF, CARA, OTTO, DAN]);
    expect(greyed(root)).toEqual([OTTO, DAN]);
  });

  it("follows the group's participant list", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(greyed(root)).toEqual([CARA, DAN]);

    dmStore.setState(() => ({
      channels: [{ ...group(), participants: [member(OTTO, "otto"), member(CARA, "cara")] }],
    }));
    dmStore.flush();
    expect(greyed(root)).toEqual([CARA]);

    dmStore.setState(() => ({
      channels: [
        {
          ...group(),
          participants: [member(OTTO, "otto"), member(CARA, "cara"), member(5, "eve")],
        },
      ],
    }));
    dmStore.flush();
    expect(greyed(root)).toEqual([CARA, 5]);
  });

  it("greys the absent members in the live strip too", () => {
    setVoice(null, [vu(OTTO)]);
    const { root } = mount();
    expect(root.dataset.state).toBe("live");
    const faces = [...root.querySelectorAll<HTMLElement>(".dcp-faces .dcp-avatar")];
    expect(faces.map((e) => Number(e.dataset.userId))).toEqual([OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([CARA, DAN]);
    for (const id of [CARA, DAN]) {
      expect(tile(root, id).title).toBe("Not in call");
      expect(tile(root, id).querySelector(".sr-only")!.textContent).toBe("Not in call");
    }
    expect(tile(root, OTTO).title).toBe("");
  });

  it("offers Ring again after a peer leaves, while someone is missing, and re-rings", () => {
    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA), vu(DAN)]);
    const { opts, root } = mount();
    expect(q(root, "dcp-ring-again")).toBeNull();

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA)]);
    expect(root.dataset.state).toBe("connected");
    expect(q(root, "dcp-ring-again")!.textContent).toBe("Ring again");
    q(root, "dcp-ring-again")!.click();
    expect(opts.onRingAgain).toHaveBeenCalledWith(DM);

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA), vu(DAN)]);
    expect(q(root, "dcp-ring-again")).toBeNull();
  });

  it("draws the greyed members as avatar tiles in the video grid", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    hostAvatars(opts);

    expect(
      [...root.querySelectorAll<HTMLElement>(".dcp-avatar--absent")].map((e) =>
        Number(e.dataset.userId),
      ),
    ).toEqual([CARA, DAN]);
    for (const id of [CARA, DAN]) {
      expect(tile(root, id).title).toBe("Not in call");
      expect(tile(root, id).querySelector(".sr-only")!.textContent).toBe("Not in call");
    }
  });

  it("leaves a 1:1 call without a roster or Ring again", () => {
    dmStore.setState(() => ({ channels: [dm()] }));
    dmStore.flush();
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(ids(root)).toEqual([SELF, OTTO]);
    expect(greyed(root)).toEqual([]);
    expect(q(root, "dcp-ring-again")).toBeNull();
  });
});
