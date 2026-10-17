/**
 * Every per-server store registers its reset with the session registry, and
 * clearAuth runs them (ARCH-012). The probe table is the contract: a store that
 * holds per-server data and is not registered fails the first test, and a
 * registration with no probe fails the second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSessionResets, registerSessionReset } from "../../src/lib/sessionRegistry";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { voiceStore } from "../../src/stores/voice.store";
import { messagesStore } from "../../src/stores/messages.store";
import { channelsStore } from "../../src/stores/channels.store";
import { blocksStore, setUserBlockedByMe } from "../../src/stores/blocks.store";
import {
  collapseCategories,
  loadCollapsedCategories,
  setActiveDmUser,
  setSidebarMode,
  uiStore,
} from "../../src/stores/ui.store";
import { membersStore, setMembers, setTyping } from "../../src/stores/members.store";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { safetyStore, setReadyNotices } from "../../src/features/safety/store";
import { memberTimeoutsStore, setMemberTimeouts } from "../../src/features/moderation/store";
// Loaded for its registrations: the two notification resets.
import "../../src/lib/notifications";
import type { ReadyMember } from "../../src/lib/types";

interface Probe {
  /** The registry name this probe covers. */
  readonly name: string;
  mutate(): void;
  isInitial(): boolean;
}

const member = {
  id: 7,
  username: "alex",
  avatar: null,
  role: "member",
  status: "online",
} as unknown as ReadyMember;

const dm = {
  channelId: 9,
  recipient: { id: 7, username: "alex", avatar: "", status: "online" },
  participants: [],
  name: "",
  isGroup: false,
  lastMessageId: null,
  lastMessage: "hi",
  lastMessageAt: "",
  unreadCount: 3,
  mentionCount: 1,
} as DmChannel;

let membersRevBefore = 0;

const PROBES: readonly Probe[] = [
  {
    name: "voice:store",
    mutate: () => voiceStore.setState((s) => ({ ...s, currentChannelId: 3, voiceStatus: "idle" })),
    isInitial: () => voiceStore.getState().currentChannelId === null,
  },
  {
    name: "messages:store",
    mutate: () => messagesStore.setState((s) => ({ ...s, detachedChannels: new Set([42]) })),
    isInitial: () => messagesStore.getState().detachedChannels.size === 0,
  },
  {
    name: "channels:store",
    mutate: () => channelsStore.setState((s) => ({ ...s, activeChannelId: 42 })),
    isInitial: () => channelsStore.getState().activeChannelId === null,
  },
  {
    name: "blocks:store",
    mutate: () => setUserBlockedByMe(5, true),
    isInitial: () => blocksStore.getState().blockedByMe.size === 0,
  },
  {
    name: "ui:session",
    mutate: () => {
      loadCollapsedCategories("a.example");
      collapseCategories(["Text"]);
      setSidebarMode("dms");
      setActiveDmUser(7);
    },
    isInitial: () =>
      uiStore.getState().collapsedCategories.size === 0 &&
      uiStore.getState().sidebarMode === "channels" &&
      uiStore.getState().activeDmUserId === null,
  },
  {
    // The roster, and the typing timers it owns (asserted by timer count).
    name: "members:store",
    mutate: () => {
      membersRevBefore = membersStore.getState().roleRevision ?? 0;
      setMembers([member]);
      setTyping(1, 7);
    },
    isInitial: () =>
      membersStore.getState().members.size === 0 &&
      membersStore.getState().typingUsers.size === 0 &&
      vi.getTimerCount() === 0 &&
      (membersStore.getState().roleRevision ?? 0) > membersRevBefore,
  },
  {
    name: "dm:store",
    mutate: () => setDmChannels([dm]),
    isInitial: () => dmStore.getState().channels.length === 0,
  },
  {
    name: "safety:store",
    mutate: () =>
      setReadyNotices([
        { id: 1, kind: "warning", reason: "r", created_at: "2026-01-01T00:00:00Z" },
      ]),
    isInitial: () => safetyStore.getState().notices.length === 0,
  },
  {
    name: "moderation:timeouts",
    mutate: () => setMemberTimeouts([{ user_id: 7, expires_at: "2099-01-01T00:00:00Z" }]),
    isInitial: () => memberTimeoutsStore.getState() === null,
  },
  // Module-state resets with no store to read: registered and run, asserted by
  // the registry check below rather than by a state probe.
  { name: "notifications:audio", mutate: () => undefined, isInitial: () => true },
  { name: "notifications:coalescing", mutate: () => undefined, isInitial: () => true },
];

/** Anonymous `onAuthCleared` listeners (page-scoped and legacy) are numbered. */
const isAnonymous = (name: string): boolean => name.startsWith("auth-cleared#");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session reset completeness", () => {
  it("server_switch resets every per-server store and cache to its initial state", () => {
    for (const probe of PROBES) probe.mutate();

    clearAuth("server_switch");

    const stale = PROBES.filter((p) => !p.isInitial()).map((p) => p.name);
    expect(stale).toEqual([]);
    expect(authStore.getState().logoutReason).toBe("server_switch");
  });

  it("every registered reset has a probe, and every probe is registered", () => {
    const registered = listSessionResets().filter((n) => !isAnonymous(n));
    const probed = PROBES.map((p) => p.name);
    expect(registered.filter((n) => !probed.includes(n))).toEqual([]);
    expect(probed.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it("runs phases in order with voice before any domain reset", () => {
    const order = listSessionResets();
    const phased = (name: string): number => order.indexOf(name);
    for (const domain of ["messages:store", "channels:store", "members:store", "dm:store"]) {
      expect(phased("voice:store")).toBeLessThan(phased(domain));
    }
    for (const session of ["notifications:audio", "notifications:coalescing"]) {
      expect(phased(session)).toBeLessThan(phased("voice:store"));
    }
  });

  it("takes the voice snapshot before the first session entry runs", () => {
    voiceStore.setState((s) => ({ ...s, currentChannelId: 3, voiceStatus: "idle" }));
    // A session entry that wipes voice state must not change what the
    // snapshot reported.
    const dispose = registerSessionReset(
      "test:session-wipes-voice",
      () => voiceStore.setState((s) => ({ ...s, currentChannelId: null })),
      { phase: "session" },
    );
    try {
      clearAuth("user");
    } finally {
      dispose();
    }
    expect(authStore.getState().logoutWasInVoice).toBe(true);
  });
});
