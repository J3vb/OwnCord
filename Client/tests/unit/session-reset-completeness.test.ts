/**
 * Every per-server store registers its reset with the session registry, and
 * clearAuth runs them (ARCH-012). The probe table is the contract. The set of
 * names registered anywhere under src/ is collected from the source text, not
 * from this file's import graph, and must equal the probe names plus the
 * commented EXEMPT list: a registration added in any module fails the
 * completeness test until it gets a probe or an exemption.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

let roleRevBefore = 0;
let snapshotRevBefore = 0;
const COLLAPSED_KEY = "owncord:collapsed:a.example";

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
      localStorage.removeItem(COLLAPSED_KEY);
      loadCollapsedCategories("a.example");
      collapseCategories(["Text"]);
      setSidebarMode("dms");
      setActiveDmUser(7);
    },
    isInitial: () => {
      const cleared =
        uiStore.getState().collapsedCategories.size === 0 &&
        uiStore.getState().sidebarMode === "channels" &&
        uiStore.getState().activeDmUserId === null;
      // The persistence host must be nulled too: a collapse after the reset
      // writes no key for the old server. (Side effect, run after the reads.)
      localStorage.removeItem(COLLAPSED_KEY);
      collapseCategories(["Probe"]);
      const hostNulled = localStorage.getItem(COLLAPSED_KEY) === null;
      localStorage.removeItem(COLLAPSED_KEY);
      return cleared && hostNulled;
    },
  },
  {
    // The roster, and the typing timers it owns (asserted by timer count).
    name: "members:store",
    mutate: () => {
      roleRevBefore = membersStore.getState().roleRevision ?? 0;
      snapshotRevBefore = membersStore.getState().snapshotRevision ?? 0;
      setMembers([member]);
      setTyping(1, 7);
    },
    isInitial: () =>
      membersStore.getState().members.size === 0 &&
      membersStore.getState().typingUsers.size === 0 &&
      vi.getTimerCount() === 0 &&
      (membersStore.getState().roleRevision ?? 0) > roleRevBefore &&
      (membersStore.getState().snapshotRevision ?? 0) > snapshotRevBefore,
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
];

/**
 * Registered names that cannot be probed in this file, each with the reason.
 * Adding to this list is a review decision: say where the behaviour is tested.
 */
const EXEMPT: readonly string[] = [
  // main.ts is not loaded here; session-isolation.test.ts drives it and pins
  // that it runs before the domain resets.
  "main:pending-and-api",
  // Module state with no readable store (an audio context, a coalescing map);
  // the notification tests cover what each does.
  "notifications:audio",
  "notifications:coalescing",
  // Per-subscriber names built from a counter in auth.store (onAuthCleared).
  "auth-cleared#${authClearedSeq}",
];

/** Every `registerSessionReset("<name>"` literal under src/, by source text. */
function registeredNamesInSource(): Set<string> {
  const names = new Set<string>();
  const re = /registerSessionReset\(\s*[`'"]([^`'"]+)[`'"]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(re)) names.add(m[1]!);
      }
    }
  };
  walk(join(__dirname, "../../src"));
  return names;
}

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

  it("every registration in src/ has a probe or an exemption, and every probe is live", () => {
    const inSource = registeredNamesInSource();
    const accounted = new Set([...PROBES.map((p) => p.name), ...EXEMPT]);
    expect([...inSource].filter((n) => !accounted.has(n)).sort()).toEqual([]);
    expect([...accounted].filter((n) => !inSource.has(n)).sort()).toEqual([]);
    // A probe whose registration never ran would pass the reset check vacuously.
    const live = listSessionResets();
    expect(PROBES.map((p) => p.name).filter((n) => !live.includes(n))).toEqual([]);
  });

  it("runs the phases in order whatever the registration order", () => {
    const calls: string[] = [];
    const disposers = (["cache", "domain", "voice", "session"] as const).map((phase) =>
      registerSessionReset(`test:order-${phase}`, () => calls.push(phase), { phase }),
    );
    try {
      clearAuth("user");
    } finally {
      for (const dispose of disposers) dispose();
    }
    expect(calls).toEqual(["session", "voice", "domain", "cache"]);
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
