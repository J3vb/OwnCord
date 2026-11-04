/**
 * The sidebar's voice wrapper is exactly the view's draw of the projected
 * inputs (5.4c-1, kept by 5.4c-2).
 *
 * 5.4c-1 pinned the view byte for byte against the old renderer. Since 5.4c-2
 * the sidebar draws with the view, so this no longer compares against an
 * independent renderer: it checks that the sidebar's projection of the stores
 * agrees with the models built here, and that the sidebar wiring adds nothing
 * to the wrapper beyond the drop target and list placement. The view's own DOM
 * is pinned by the property tests and by the sidebar and e2e selectors.
 *
 * One normalisation, of state the view does not own: the `.channel-item`
 * tabindex is set by the roving navigation after every render, so the sidebar
 * copy is put back to the drawn "-1".
 */

import { makeVoiceUser as vu } from "../helpers/voiceUsers";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const { localMuted, volumes } = vi.hoisted(() => ({
  localMuted: new Set<number>(),
  volumes: new Map<number, number>(),
}));
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    getUserVolume: (userId: number) => volumes.get(userId) ?? 1,
    getUserLocalMute: (userId: number) => localMuted.has(userId),
  }),
);
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return {
    ...actual,
    fetchImageAsObjectUrl: vi.fn((url: string) =>
      Promise.resolve(`data:,${encodeURIComponent(url)}`),
    ),
  };
});

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { membersStore, type Member } from "../../src/stores/members.store";
import { voiceStore, type PeerVerification, type VoiceUser } from "../../src/stores/voice.store";
import { resetSafetyStore, safetyStore, setActiveTimeout } from "../../src/features/safety/store";
import { markVoiceDropTarget } from "../../src/features/voice/dragMove";
import { createAvatarElement, pickAvatarColor } from "../../src/features/profiles/avatar";
import { getUserLocalMute, getUserVolume } from "@lib/voice/livekitSession";
import {
  drawVoiceChannelChrome,
  drawVoiceUserRow,
} from "../../src/features/channels/voiceRow.view";
import {
  channelVoiceUsers,
  voiceChannelChrome,
  voiceUserModel,
  type VoiceRowInputs,
} from "../../src/features/channels/voiceRowModel";
import type { ReadyChannel } from "../../src/lib/types";
import { signInAs, resetChannelsState } from "../helpers/storeSeeds";

const CH = 10;
const SELF = 1;

function voiceChannel(over: Partial<ReadyChannel> = {}): ReadyChannel {
  return { id: CH, name: "lobby", type: "voice", category: "Voice", position: 0, ...over };
}

function setVoice(
  users: readonly VoiceUser[],
  opts: {
    current?: number | null;
    verifications?: readonly PeerVerification[];
    fingerprint?: string | null;
  } = {},
): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: opts.current ?? null,
    voiceUsers: new Map(
      users.length > 0 ? [[CH, new Map(users.map((u) => [u.userId, u] as const))]] : [],
    ),
    peerVerifications: new Map((opts.verifications ?? []).map((v) => [v.userId, v] as const)),
    localSessionFingerprint: opts.fingerprint ?? null,
  }));
}

/** The projection 5.4c-2's `select` returns, read from the stores here. */
function snapshot(): VoiceRowInputs {
  const voice = voiceStore.getState();
  const members = membersStore.getState().members;
  const voiceMembers = new Map<number, Member>();
  for (const users of voice.voiceUsers.values()) {
    for (const uid of users.keys()) {
      const m = members.get(uid);
      if (m !== undefined) voiceMembers.set(uid, m);
    }
  }
  return {
    voiceUsers: voice.voiceUsers,
    currentChannelId: voice.currentChannelId,
    peerVerifications: voice.peerVerifications ?? new Map(),
    localSessionFingerprint: voice.localSessionFingerprint ?? null,
    localSafetyNumber: voice.localSafetyNumber ?? null,
    voiceMembers,
    selfId: authStore.getState().user?.id ?? null,
    connectionStatus: uiStore.getState().connectionStatus,
    timeout: safetyStore.getState().timeout,
    movable: Array.from(channelsStore.getState().channels.values())
      .filter((ch) => ch.type === "voice" && ch.canMoveVoice === true)
      .map((ch) => ch.id)
      .toSorted((a, b) => a - b),
    localMute: {},
  };
}

/** The wrapper 5.4c-2 builds: the chrome, the drop target, the user list. */
function drawWithView(moderation: boolean): HTMLElement {
  const snap = snapshot();
  const wrapper = drawVoiceChannelChrome(
    voiceChannelChrome(channelsStore.getState().channels.get(CH)!, snap),
  );
  if (moderation) markVoiceDropTarget(wrapper, CH);
  const users = channelVoiceUsers(snap, CH);
  if (users.length > 0) {
    const list = document.createElement("div");
    list.className = "voice-users-list";
    const ctx = {
      avatarColor: pickAvatarColor,
      localSilenced: (uid: number) => getUserLocalMute(uid) || getUserVolume(uid) === 0,
      moderation,
    };
    for (const u of users) {
      list.appendChild(drawVoiceUserRow(voiceUserModel(u, CH, snap, ctx), createAvatarElement));
    }
    wrapper.appendChild(list);
  }
  return wrapper;
}

/** A flush long enough for each avatar's fetch and its image swap. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Sort each element's class tokens, for the one case the order differs by design. */

describe("voice row view matches today's renderVoiceChannelItem", () => {
  let container: HTMLDivElement;
  let holder: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar> | null = null;

  beforeEach(() => {
    localMuted.clear();
    volumes.clear();
    resetSafetyStore();
    resetChannelsState();
    signInAs({ id: SELF, username: "user1", avatar: null, role: "member" });
    uiStore.setState((prev) => ({
      ...prev,
      connectionStatus: "connected",
      collapsedCategories: new Set<string>(),
    }));
    membersStore.setState((prev) => ({ ...prev, members: new Map() }));
    setVoice([]);
    container = document.createElement("div");
    holder = document.createElement("div");
    document.body.append(container, holder);
  });

  afterEach(() => {
    sidebar?.destroy?.();
    sidebar = null;
    resetSafetyStore();
    container.remove();
    holder.remove();
  });

  async function compare(moderation: boolean): Promise<void> {
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      ...(moderation
        ? {
            onVoiceModerate: {
              onServerMute: vi.fn(),
              onServerDeafen: vi.fn(),
              onMove: vi.fn(),
              onDisconnect: vi.fn(),
            },
          }
        : {}),
    });
    sidebar.mount(container);
    const expected = drawWithView(moderation);
    holder.appendChild(expected);
    await settle();

    const live = container.querySelector(`[data-testid="channel-${CH}"]`)!.parentElement!;
    const actual = live.cloneNode(true) as HTMLElement;
    actual.querySelector(".channel-item")!.setAttribute("tabindex", "-1");

    expect(expected.outerHTML).toBe(actual.outerHTML);
  }

  it("an empty channel", async () => {
    setChannels([voiceChannel()]);
    await compare(false);
  });

  it("a joined, capped channel with every participant state", async () => {
    setChannels([voiceChannel({ voice_max_users: 5 })]);
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map<number, Member>([
        [
          2,
          {
            id: 2,
            username: "user2",
            avatar: "/api/v1/files/a2",
            role: "member",
            status: "online",
            displayName: "Nick",
          },
        ],
        [
          3,
          {
            id: 3,
            username: "user3",
            avatar: null,
            role: "member",
            status: "online",
            displayName: "  ",
          },
        ],
      ]),
    }));
    localMuted.add(6);
    volumes.set(7, 0);
    setVoice(
      [
        vu(SELF, { muted: true }),
        vu(2),
        vu(3, { muted: true, deafened: true, serverMuted: true, serverDeafened: true }),
        vu(4, { muted: true, serverMuted: true }),
        vu(5, { camera: true, screenshare: true, speaking: true }),
        vu(6, { muted: true, deafened: true }),
        vu(7, { serverMuted: undefined, serverDeafened: undefined, muted: true }),
        vu(8, { muted: true, deafened: true, serverMuted: true }),
        vu(9, { username: "" }),
      ],
      {
        current: CH,
        fingerprint: "0123 4567 89AB CDEF",
        verifications: [
          { userId: 2, status: "verified", safetyNumber: "11111 22222", sessionFingerprint: "AA" },
          { userId: 3, status: "mismatch", safetyNumber: null, sessionFingerprint: null },
          { userId: 4, status: "unverified", safetyNumber: null, sessionFingerprint: "BEEF" },
          { userId: 5, status: "changed", safetyNumber: "33333", sessionFingerprint: "CC" },
          { userId: 6, status: "unknown", safetyNumber: null, sessionFingerprint: null },
          { userId: 8, status: "verified", safetyNumber: null, sessionFingerprint: null },
          { userId: 9, status: "unverified", safetyNumber: null, sessionFingerprint: null },
        ],
      },
    );
    await compare(false);
    // The picture really was swapped in on both sides, so the comparison covers it.
    expect(container.querySelector('[data-voice-uid="2"] .avatar-img')).not.toBeNull();
    expect(container.querySelectorAll(".voice-user-item")).toHaveLength(9);
  });

  it("a timed-out, age-restricted, private channel", async () => {
    setChannels([voiceChannel({ nsfw: true, private: true, voice_max_users: 2 })]);
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    setVoice([vu(2)]);
    await compare(false);
  });

  it("a frozen channel while reconnecting, and while disconnected", async () => {
    setChannels([voiceChannel()]);
    setVoice([vu(2), vu(SELF)], { current: CH });
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    await compare(false);
    sidebar?.destroy?.();
    container.replaceChildren();
    holder.replaceChildren();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
    await compare(false);
  });

  it("moderation: draggable rows and the drop target", async () => {
    setChannels([voiceChannel({ can_moderate_voice: true })]);
    setVoice([vu(SELF), vu(2), vu(3, { muted: true })]);
    await compare(true);
  });

  it("moderation without a verdict: no draggable rows", async () => {
    setChannels([voiceChannel()]);
    setVoice([vu(SELF), vu(2, { speaking: true })]);
    await compare(true);
  });

  it("a speaking, draggable row", async () => {
    setChannels([voiceChannel({ can_moderate_voice: true })]);
    setVoice([vu(SELF), vu(2, { speaking: true })]);
    await compare(true);
  });
});
