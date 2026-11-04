import { vi, beforeEach, afterEach } from "vitest";
import {
  createDmCallPanel,
  type DmCallPanelComponent,
  type DmCallPanelOptions,
} from "../../src/features/direct-messages/DmCallPanel";
import {
  voiceStore,
  clearPeerVerifications,
  setLocalSafetyNumber,
  setLocalSessionFingerprint,
  type VoiceUser,
} from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import { dmRecipient, makeDm } from "./dmHarness";
import { voiceUser } from "./voiceUsers";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { RingState } from "../../src/lib/voice/callRing";
import { makeChannelRow, signInAs } from "./storeSeeds";

export const SELF = 1;

export const OTTO = 2;

export const DM = 100;

export const dm = (overrides: Partial<DmChannel> = {}): DmChannel => {
  const other = dmRecipient(OTTO, "otheruser");
  return makeDm({ channelId: DM, recipient: other, participants: [other], ...overrides });
};

export const vu = (userId: number, extra: Partial<VoiceUser> = {}): VoiceUser =>
  voiceUser(userId, { username: userId === SELF ? "me" : "otheruser", ...extra });

export const CARA = 3;

export const DAN = 4;

export const member = (id: number, name = `user${id}`): DmChannel["participants"][number] => ({
  id,
  username: name,
  avatar: "",
  status: "online",
});

export const ring: RingState = { channelId: DM, fromUserId: OTTO, fromUsername: "Otto" };

export function setVoice(
  currentChannelId: number | null,
  users: VoiceUser[],
  channelId = DM,
): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId,
    voiceUsers: new Map([[channelId, new Map(users.map((u) => [u.userId, u]))]]),
    joinedAt: currentChannelId === null ? null : Date.now(),
  }));
  voiceStore.flush();
}

export function patchVoice(patch: Partial<ReturnType<typeof voiceStore.getState>>): void {
  voiceStore.setState((prev) => ({ ...prev, ...patch }));
  voiceStore.flush();
}

export type MockedOptions = {
  [K in keyof DmCallPanelOptions]-?: K extends "videoGrid"
    ? { setPeople: ReturnType<typeof vi.fn> }
    : ReturnType<typeof vi.fn>;
};

export function options(): MockedOptions {
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

export let host: HTMLDivElement;

export let panel: DmCallPanelComponent | null = null;

export function mount(opts = options()): { opts: MockedOptions; root: HTMLElement } {
  panel = createDmCallPanel(opts as unknown as DmCallPanelOptions);
  panel.mount(host);
  const root = host.querySelector<HTMLElement>("[data-testid='dm-call-panel']")!;
  return { opts, root };
}

/** Stand in for the shared grid hosting the avatar tiles the panel hands it. */
export function hostAvatars(opts: MockedOptions): void {
  const hostEl = panel!.videoElement()!;
  const calls = opts.videoGrid.setPeople.mock.calls;
  const people = calls[calls.length - 1]![0] as { content: HTMLElement }[];
  for (const p of people) hostEl.appendChild(p.content);
}

export const q = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);

export const shield = (root: HTMLElement, id: number) =>
  root.querySelector<HTMLElement>(`.dcp-avatar[data-user-id='${id}'] .dcp-verify`);

// Wherever it sits: on the avatar, or on a camera tile in the grid.
export const anyShield = (root: HTMLElement) => root.querySelector<HTMLElement>(".dcp-verify");

export const timer = (root: HTMLElement) => root.querySelector(".dcp-timer")!.textContent;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  signInAs(
    { id: SELF, username: "me", avatar: null, role: "member" },
    { token: "t", serverName: "s", motd: "" },
  );
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
    channels: new Map([[7, makeChannelRow({ id: 7, name: "Lobby", type: "voice" })]]),
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
