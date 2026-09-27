import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The panel reuses the voice widget's status text, which pulls in the voice
// session facade; nothing here touches a real session.
vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: vi.fn().mockResolvedValue(undefined),
}));

import {
  createDmCallPanel,
  deriveCallView,
  type DmCallPanelComponent,
  type DmCallPanelOptions,
} from "../../src/components/DmCallPanel";
import { voiceStore, type VoiceUser } from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import { membersStore, updateMemberProfile, updatePresence } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { setConnectionStatus, uiStore } from "../../src/stores/ui.store";
import type { RingState, OutgoingCallState } from "../../src/lib/call-ring";

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

type MockedOptions = { [K in keyof DmCallPanelOptions]: ReturnType<typeof vi.fn> };

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

const q = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);

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

  it("is connected as soon as anyone else is in the room, whatever the ring said", () => {
    const v = deriveCallView({
      ...base,
      voice: { currentChannelId: DM, voiceUsers: room(SELF, OTTO) },
      outgoing: { channelId: DM, phase: "ringing", pending: [OTTO] },
    });
    expect(v).toMatchObject({ kind: "connected", inRoom: [SELF, OTTO] });
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

  it("keeps a moderator mute and a dropped socket out of reach, but never Leave", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    patchVoice({ localServerMuted: true });
    expect(q(root, "dcp-mute")!.disabled).toBe(true);
    expect(q(root, "dcp-deafen")!.disabled).toBe(false);

    setConnectionStatus("reconnecting");
    uiStore.flush();
    for (const id of ["dcp-deafen", "dcp-camera", "dcp-share"]) {
      expect(q(root, id)!.disabled).toBe(true);
    }
    expect(q(root, "dcp-leave")!.disabled).toBe(false);
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
