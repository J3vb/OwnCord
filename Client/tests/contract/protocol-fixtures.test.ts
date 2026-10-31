// CONTRACT TEST (ARCH-02). The epoch-1 wire fixtures under
// protocol/fixtures/epoch-1/ are the frozen transcripts of what the server
// sends (see Server/ws/protocol_epoch1_contract_test.go). Until now the CLIENT
// never checked them: dispatcher handlers cast each frame to its payload type
// and read fields by name, so a server-side rename or retype would break the
// client silently while the server's own contract test stayed green.
//
// This file feeds recorded server->client frames through the REAL client
// dispatcher (lib/dispatcher.ts, wireDispatcher) and asserts the store effect
// each frame must produce, anchored on the fixture's own content (the literal
// strings the journey used, "hello epoch one" and so on). A renamed fixture
// field no longer routes to an assertion, so the test fails.
//
// Two things shape the design. First, a fixture holds one frame list PER
// CONNECTION, and each connection is a separate client's view — so assertions
// replay one named connection. Second, the server fixture normalises every
// volatile id to a typed placeholder ("<id:number>") and does NOT keep ids
// stable across frames (see the server test's header), so an assertion never
// depends on a cross-frame id; it dispatches the single frame under test and
// anchors on a username or a literal the fixture actually kept. Placeholders
// are substituted with concrete values of the SAME type before dispatch —
// a timestamp becomes a real parseable wire timestamp, which is what lets
// handleChatMessage's parseTimestamp run, and a field that flips type fails.
//
// Client->server frames are not replayed: this is the client half of the
// contract, and the server->client frames are what the dispatcher consumes.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The dispatcher pulls in notifications; the voice handlers reach LiveKit and
// the identity publisher. None is under test here, so each is stubbed the way
// the unit dispatcher tests stub it.
vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());

vi.spyOn(console, "info").mockImplementation(() => {});

import * as dispatcherMocks from "../helpers/dispatcherMocks";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { expectConsole } from "../helpers/console";
import { repoRoot } from "../helpers/repoRoot";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, resetChannelsStore, setChannels } from "../../src/stores/channels.store";
import { membersStore, setMembers } from "../../src/stores/members.store";
import {
  addOptimisticMessage,
  getChannelMessages,
  resetMessagesStore,
  setMessages,
} from "../../src/stores/messages.store";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
import { emojiStore } from "../../src/stores/emoji.store";
import {
  voiceStore,
  getChannelVoiceUsers,
  resetVoiceStore,
  setVoiceStates,
} from "../../src/stores/voice.store";
import { uiStore } from "../../src/stores/ui.store";
import { resetBlocksStore } from "../../src/stores/blocks.store";
import type { WsClient } from "../../src/lib/ws";
import {
  messageRequestsStore,
  resetMessageRequests,
} from "../../src/features/message-requests/store";
import { createForwardSession } from "../../src/features/messaging/forwardSend";
import { createPoll, endPoll, votePoll } from "../../src/features/messaging/pollSend";
import { handleServerRestart } from "../../src/features/connection/wsHandlers";
import type { ReconnectClock } from "../../src/features/connection/dispatchContext";
import {
  memberTimeoutsStore,
  modAppealStore,
  modQueueStore,
  setMemberTimeouts,
} from "../../src/features/moderation/store";
import { safetyStore } from "../../src/features/safety/store";
import type { ServerMessage } from "../../src/lib/types";
import { showToast } from "@lib/ui/toast";
import * as livekitSession from "@lib/voice/livekitSession";
import { createOutgoingCall, createRingController } from "../../src/lib/voice/callRing";

// ─── fixture loading ─────────────────────────────────────────────────────────

interface WireFrame {
  readonly dir: "c2s" | "s2c";
  readonly frame: { readonly type: string; readonly payload?: unknown; readonly id?: string };
}
interface WireTranscript {
  readonly journey: string;
  readonly connections: Record<string, readonly WireFrame[]>;
}

const FIXTURE_DIR = path.join(repoRoot, "protocol/fixtures/epoch-1");
const FIXTURES = new Map<string, WireTranscript>(
  readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [
      f.replace(/\.json$/, ""),
      JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), "utf8")) as WireTranscript,
    ]),
);

function fixture(journey: string): WireTranscript {
  const tr = FIXTURES.get(journey);
  expect(tr, `fixture ${journey}.json`).toBeDefined();
  return tr!;
}

/** The server->client frames of one connection, in order. */
function s2c(journey: string, conn: string): WireFrame[] {
  const frames = fixture(journey).connections[conn];
  expect(frames, `${journey}: connection ${conn}`).toBeDefined();
  return frames!.filter((f) => f.dir === "s2c");
}

/** The first server->client frame of `type` in `journey`, across connections. */
function s2cFrame(journey: string, type: string): WireFrame["frame"] {
  for (const frames of Object.values(fixture(journey).connections)) {
    const found = frames.find((f) => f.dir === "s2c" && f.frame.type === type);
    if (found !== undefined) return found.frame;
  }
  throw new Error(`${journey}: no s2c ${type} frame`);
}

/** Every server->client frame of `type` in `journey`, across connections. */
function s2cFrames(journey: string, type: string): WireFrame["frame"][] {
  const out: WireFrame["frame"][] = [];
  for (const frames of Object.values(fixture(journey).connections)) {
    for (const f of frames) {
      if (f.dir === "s2c" && f.frame.type === type) out.push(f.frame);
    }
  }
  if (out.length === 0) throw new Error(`${journey}: no s2c ${type} frame`);
  return out;
}

// ─── placeholder substitution ─────────────────────────────────────────────────

const PLACEHOLDER = /^<(\w+):(\w+)>$/;

/**
 * Replace every typed placeholder in `value`, recursively. `overrides` keys
 * win, so a test can pin an id to a value it seeded (e.g. message_id). Any
 * other placeholder gets a fresh value of its declared type from a shared
 * counter, so two placeholders never collide.
 */
function substitute(
  value: unknown,
  overrides: Record<string, unknown>,
  counter: { n: number },
): unknown {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      const m = PLACEHOLDER.exec(v);
      if (m === null) return v;
      const [klass, type] = [m[1]!, m[2]!];
      if (key !== null && Object.prototype.hasOwnProperty.call(overrides, key)) {
        const pinned = overrides[key];
        const pinnedType =
          pinned === null ? "null" : typeof pinned === "boolean" ? "bool" : typeof pinned;
        if (pinnedType !== type) {
          throw new Error(`override ${key}=${String(pinned)} is ${pinnedType}, wire has ${v}`);
        }
        return pinned;
      }
      counter.n += 1;
      const n = counter.n;
      switch (type) {
        case "null":
          return null;
        case "number":
          return klass === "id" ? 1000 + n : n;
        case "bool":
          return true;
        case "string":
          switch (klass) {
            case "id":
              return `req-${n}`;
            case "token":
              return `tok-${n}`;
            case "ts":
              // The real wire form: SQLite datetime('now'), naive UTC, which
              // parseTimestamp parses by appending the Z.
              return "2026-09-05 12:00:00";
            default:
              return `${klass}-${n}`;
          }
        default:
          throw new Error(`unsupported placeholder type: ${v}`);
      }
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, key));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(value, null);
}

// ─── harness ─────────────────────────────────────────────────────────────────

/** Reset every store a dispatcher write can reach, so one replay cannot leak
 *  into the next. */
function resetStores(): void {
  resetChannelsStore();
  resetMessagesStore();
  resetVoiceStore();
  resetBlocksStore();
  resetMessageRequests();
  setMembers([]);
  setDmChannels([]);
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
  uiStore.setState((prev) => ({ ...prev, transientError: null }));
}

describe("contract: epoch-1 fixtures through the client dispatcher", () => {
  let cleanup: (() => void) | null = null;
  let ws: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    ws = createMockWsClient();
    cleanup = wireDispatcher(ws as unknown as WsClient);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
  });

  /** Feed one frame, envelope id included, with its placeholders substituted.
   *  `envelopeId` pins the envelope id the way `overrides` pin payload keys.
   *  Voice handlers lazily import the mocked livekitSession without awaiting
   *  it; two such imports in one tick bypass the mock and load the real
   *  module, so each frame's imports settle before the next frame is fed. */
  async function send(
    frame: WireFrame["frame"],
    overrides: Record<string, unknown>,
    counter: { n: number },
    envelopeId?: string,
  ): Promise<void> {
    const envelope = substitute(
      { id: frame.id },
      envelopeId === undefined ? {} : { id: envelopeId },
      counter,
    ) as { id?: string };
    ws.simulateMessage(
      frame.type as ServerMessage["type"],
      substitute(frame.payload, overrides, counter) as never,
      envelope.id,
    );
    await vi.dynamicImportSettled();
  }

  /** Feed ONE server->client frame through the wired dispatcher. */
  async function dispatch(
    journey: string,
    type: string,
    overrides: Record<string, unknown> = {},
    envelopeId?: string,
  ): Promise<void> {
    await send(s2cFrame(journey, type), overrides, { n: 0 }, envelopeId);
  }

  /** Feed a whole connection's s2c frames in order (smoke / multi-frame). */
  async function replayConnection(journey: string, conn: string): Promise<void> {
    const counter = { n: 0 };
    for (const f of s2c(journey, conn)) await send(f.frame, {}, counter);
  }

  it("auth-failure: auth_error lands in uiStore and clears auth", async () => {
    await dispatch("auth-failure", "auth_error");
    expectConsole("error", "Auth failed");
    expect(uiStore.getState().transientError).toBe("invalid token");
    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(authStore.getState().logoutReason).toBe("user");
  });

  it("fresh-connect: auth_ok authenticates from the fixture's user", async () => {
    await dispatch("fresh-connect", "auth_ok");
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().user?.username).toBe("alice");
    expect(authStore.getState().serverName).toBe("OwnCord Server");
    expect(authStore.getState().motd).toBe("Welcome!");
  });

  it("fresh-connect: ready fills channels, roles and members", async () => {
    await dispatch("fresh-connect", "ready");
    expect([...channelsStore.getState().channels.values()].map((c) => c.name).sort()).toEqual([
      "Voice",
      "general",
    ]);
    expect(channelsStore.getState().roles).toHaveLength(4);
    expect(membersStore.getState().members.size).toBe(2);
    const alice = [...membersStore.getState().members.values()].find((m) => m.username === "alice");
    expect(alice?.displayName).toBe("Alice Fixture");
  });

  it("fresh-connect: member_join adds the joining user by name", async () => {
    await dispatch("fresh-connect", "member_join");
    const alice = [...membersStore.getState().members.values()].find((m) => m.username === "alice");
    expect(alice?.status).toBe("online");
  });

  it("fresh-connect: a presence_batch entry fills the custom status", async () => {
    // The fixture does not keep ids stable, so seed the member the entry
    // patches.
    const USER_ID = 8001;
    setMembers([
      {
        id: USER_ID,
        username: "alice",
        avatar: null,
        role: "member",
        status: "offline",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
    ]);
    await dispatch("fresh-connect", "presence_batch", { user_id: USER_ID });
    expect(membersStore.getState().members.get(USER_ID)?.customStatus).toBe(
      "fixture custom status",
    );
  });

  it("chat-send-fanout: the broadcast is appended with its fixture content", async () => {
    await dispatch("chat-send-fanout", "chat_message");
    expect(getChannelMessages(1).some((m) => m.content === "hello epoch one")).toBe(true);
  });

  it("chat-send-fanout: chat_send_ok confirms the pending send it acknowledges", async () => {
    const CORRELATION_ID = "send-1";
    const MESSAGE_ID = 5002;
    addOptimisticMessage({
      correlationId: CORRELATION_ID,
      channelId: 1,
      user: { id: 1, username: "alice", avatar: null },
      content: "hello epoch one",
      replyTo: null,
      timestamp: "2026-09-05 11:00:00",
    });
    await dispatch("chat-send-fanout", "chat_send_ok", { message_id: MESSAGE_ID }, CORRELATION_ID);
    const row = getChannelMessages(1).find((m) => m.content === "hello epoch one");
    expect(row).toMatchObject({
      id: MESSAGE_ID,
      status: "sent",
      timestamp: "2026-09-05 12:00:00",
    });
  });

  it("chat-edit-delete: edit rewrites content, delete tombstones the row", async () => {
    // The message is created server-side (setup), so the fixture carries no
    // chat_message for it — seed the row at the id the frames name.
    const MESSAGE_ID = 5000;
    setMessages(
      1,
      [
        {
          id: MESSAGE_ID,
          channel_id: 1,
          user: { id: 1, username: "alice", avatar: null, role: "member" },
          content: "original text",
          reply_to: null,
          attachments: [],
          reactions: [],
          pinned: false,
          edited_at: null,
          deleted: false,
          timestamp: "2026-09-05 11:00:00",
        } as never,
      ],
      false,
    );
    await dispatch("chat-edit-delete", "chat_edited", { message_id: MESSAGE_ID });
    expect(getChannelMessages(1).find((m) => m.id === MESSAGE_ID)?.content).toBe("edited text");
    await dispatch("chat-edit-delete", "chat_deleted", { message_id: MESSAGE_ID });
    expect(getChannelMessages(1).find((m) => m.id === MESSAGE_ID)?.deleted).toBe(true);
  });

  it("reaction-add-remove: add then remove returns the reaction list to empty", async () => {
    const MESSAGE_ID = 5001;
    setMessages(
      1,
      [
        {
          id: MESSAGE_ID,
          channel_id: 1,
          user: { id: 1, username: "alice", avatar: null, role: "member" },
          content: "react to me",
          reply_to: null,
          attachments: [],
          reactions: [],
          pinned: false,
          edited_at: null,
          deleted: false,
          timestamp: "2026-09-05 11:00:00",
        } as never,
      ],
      false,
    );
    // The fixture records add then remove as two frames; both must land on the
    // seeded row for the list to return to empty. One shared counter keeps the
    // two frames' generated user ids from colliding onto the same value.
    const counter = { n: 0 };
    for (const frame of s2cFrames("reaction-add-remove", "reaction_update")) {
      await send(frame, { message_id: MESSAGE_ID }, counter);
    }
    expect(getChannelMessages(1).find((m) => m.id === MESSAGE_ID)?.reactions).toEqual([]);
  });

  it("typing: the indicator is keyed on the fixture's channel id", async () => {
    await dispatch("typing", "typing");
    expect(membersStore.getState().typingUsers.get(1)?.size).toBe(1);
  });

  it("channel-activity: b's hint marks the unfocused channel unread, not mentioned", async () => {
    const MESSAGE_ID = 5003;
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    await dispatch("channel-activity", "channel_activity", { message_id: MESSAGE_ID });
    expect(channelsStore.getState().channels.get(1)).toMatchObject({
      unreadCount: 1,
      mentionCount: 0,
      lastMessageId: MESSAGE_ID,
    });
  });

  it("dm-send: the DM broadcast is appended to its DM channel", async () => {
    await dispatch("dm-send", "chat_message");
    expect(getChannelMessages(3).some((m) => m.content === "hello over dm")).toBe(true);
  });

  it("dm-request: the pending request lands in the message-requests store", async () => {
    await dispatch("dm-request", "dm_request");
    const state = messageRequestsStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.channelId).toBe(3);
    expect(state.pending[0]!.preview?.content).toBe("hi, stranger");
    expect(state.pending[0]!.createdAt).toBe("2026-09-05 12:00:00");
  });

  it("dm-request-ignored: b's view is genuine silence (no request, no message)", async () => {
    await replayConnection("dm-request-ignored", "b");
    expect(messageRequestsStore.getState().pending).toHaveLength(0);
    expect(getChannelMessages(3)).toHaveLength(0);
  });

  it("resume-replay: replayed chat_message is applied", async () => {
    await dispatch("resume-replay", "chat_message");
    expect(getChannelMessages(1).some((m) => m.content === "sent while away")).toBe(true);
  });

  it("resume-replay: the back-online presence restores the member's status", async () => {
    const USER_ID = 8002;
    setMembers([
      {
        id: USER_ID,
        username: "bob",
        avatar: null,
        role: "member",
        status: "offline",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
    ]);
    // The journey records a disconnect (offline) presence and then a
    // back-online one; replay the back-online frame, which is the effect under
    // test. Its custom_status is the fixture's own literal.
    const online = s2cFrames("resume-replay", "presence_batch").find(
      (f) => (f.payload as { updates?: { status?: string }[] }).updates?.[0]?.status === "online",
    );
    expect(online, "resume-replay: back-online presence frame").toBeDefined();
    await send(online!, { user_id: USER_ID }, { n: 0 });
    const bob = membersStore.getState().members.get(USER_ID);
    expect(bob?.status).toBe("online");
    expect(bob?.customStatus).toBe("fixture custom status");
  });

  it("voice-join-e2ee-leave: voice_state adds the named user to the roster", async () => {
    await dispatch("voice-join-e2ee-leave", "voice_state");
    expect(getChannelVoiceUsers(2).some((u) => u.username === "alice")).toBe(true);
  });

  it("voice-join-e2ee-leave: voice_config is keyed on the fixture's channel id", async () => {
    await dispatch("voice-join-e2ee-leave", "voice_config");
    expect(voiceStore.getState().voiceConfigs.get(2)).toMatchObject({
      quality: "medium",
      bitrate: 64000,
      threshold_mode: "top_speakers",
      max_users: 0,
    });
  });

  it("voice-join-e2ee-leave: voice_leave removes the named user from the roster", async () => {
    const USER_ID = 8100;
    setVoiceStates([
      {
        user_id: USER_ID,
        channel_id: 2,
        muted: false,
        deafened: false,
        camera: false,
        screenshare: false,
        server_muted: false,
        server_deafened: false,
      },
    ]);
    await dispatch("voice-join-e2ee-leave", "voice_leave", { user_id: USER_ID });
    expect(getChannelVoiceUsers(2).some((u) => u.userId === USER_ID)).toBe(false);
  });

  // ── WP 7.3a: voice self-state, moderation, calls and error frames ─────────

  /** Let the voice handlers' lazy `livekitSession()` import and the `.then`
   *  bodies that follow it run before the assertion reads their effects. */
  async function settle(): Promise<void> {
    await vi.dynamicImportSettled();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("voice-self-state: each voice_state broadcast sets exactly the flags it carries", async () => {
    // alice's connection records her own joins and her own eight toggles. The
    // fixture does not keep user ids stable across frames, so one id is pinned
    // for every alice frame; bob's relayed state (the second frame) is left out.
    const USER_ID = 8200;
    const frames = s2cFrames("voice-self-state", "voice_state").filter(
      (f) => (f.payload as { username?: string }).username === "alice",
    );
    // Join, then mute on/off, deafen on/off, camera on/off, screenshare on/off.
    const expected = [
      { muted: false, deafened: false, camera: false, screenshare: false },
      { muted: true, deafened: false, camera: false, screenshare: false },
      { muted: false, deafened: false, camera: false, screenshare: false },
      { muted: false, deafened: true, camera: false, screenshare: false },
      { muted: false, deafened: false, camera: false, screenshare: false },
      { muted: false, deafened: false, camera: true, screenshare: false },
      { muted: false, deafened: false, camera: false, screenshare: false },
      { muted: false, deafened: false, camera: false, screenshare: true },
      { muted: false, deafened: false, camera: false, screenshare: false },
    ];
    // Both connections record alice's states; the list is the first n of them.
    const aliceOnly = frames.slice(0, expected.length);
    expect(aliceOnly).toHaveLength(expected.length);
    const counter = { n: 0 };
    for (const [i, frame] of aliceOnly.entries()) {
      await send(frame, { user_id: USER_ID }, counter);
      const user = getChannelVoiceUsers(2).find((u) => u.userId === USER_ID);
      expect(user, `voice_state ${i}`).toMatchObject(expected[i]!);
    }
  });

  it("voice-moderation: server mute and deafen land in the roster's server_* flags", async () => {
    // bob is the target; his connection records each broadcast.
    const USER_ID = 8201;
    const states = s2c("voice-moderation", "b")
      .map((f) => f.frame)
      .filter(
        (f) => f.type === "voice_state" && (f.payload as { username?: string }).username === "bob",
      );
    // After the join relay: server mute on, off, server deafen on (implies mute), off.
    const flags = states.map((f) => {
      const p = f.payload as { server_muted: boolean; server_deafened: boolean };
      return [p.server_muted, p.server_deafened];
    });
    expect(flags).toEqual([
      [false, false],
      [true, false],
      [false, false],
      [true, true],
      [false, false],
    ]);
    const counter = { n: 0 };
    for (const frame of states) {
      await send(frame, { user_id: USER_ID }, counter);
      const p = frame.payload as { server_muted: boolean; server_deafened: boolean };
      const user = getChannelVoiceUsers(2).find((u) => u.userId === USER_ID);
      expect(user).toMatchObject({
        serverMuted: p.server_muted,
        serverDeafened: p.server_deafened,
      });
    }
  });

  it("voice-moderation-move-kick: voice_moved leaves the room and re-joins the fixture's destination", async () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 2 }));
    ws.clearSent();
    // The server fixture normalises every *_id, to_channel_id included, so the
    // destination (the seeded second voice channel) is pinned here rather than
    // read from the fixture.
    await dispatch("voice-moderation-move-kick", "voice_moved", { to_channel_id: 3 });
    await settle();
    expect(vi.mocked(livekitSession.leaveVoice)).toHaveBeenCalledWith(false);
    expect(voiceStore.getState().currentChannelId).toBe(3);
    expect(ws.getSentMessages().map((m) => ({ type: m.type, payload: m.payload }))).toEqual([
      { type: "voice_join", payload: { channel_id: 3 } },
    ]);
  });

  it("voice-moderation-move-kick: voice_disconnected tears the session down and toasts the reason", async () => {
    // The kick's voice_leave has already cleared the store by the time this
    // arrives (the ordinary path), so currentChannelId is null here.
    vi.mocked(showToast).mockClear();
    vi.mocked(livekitSession.leaveVoice).mockClear();
    await dispatch("voice-moderation-move-kick", "voice_disconnected");
    await settle();
    expect(vi.mocked(livekitSession.leaveVoice)).toHaveBeenCalledWith(false);
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      "You were disconnected from voice by a moderator",
      "error",
    );
  });

  it("voice-moderation-move-kick: a voice_disconnected for another channel than the live one is stale", async () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 2 }));
    vi.mocked(showToast).mockClear();
    // The fixture's frame names channel 3; the client has since joined 2.
    await dispatch("voice-moderation-move-kick", "voice_disconnected");
    await settle();
    expect(voiceStore.getState().currentChannelId).toBe(2);
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });

  it("voice-mod-denied: the error frame becomes a toast with the server's text", async () => {
    vi.mocked(showToast).mockClear();
    await dispatch("voice-mod-denied", "error");
    expectConsole("error", "Server error");
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    const [text, kind] = vi.mocked(showToast).mock.calls[0]!;
    // serverErrorText capitalises the server's message; the code is FORBIDDEN.
    expect(text).toBe("Cannot moderate a user of equal or higher rank");
    expect(kind).toBe("error");
  });

  it("voice-token-refresh: the refresh reply is a voice_token the dispatcher hands to the session", async () => {
    // The first voice_token on a is the join's, the second the refresh's.
    const tokens = s2c("voice-token-refresh", "a").filter((f) => f.frame.type === "voice_token");
    expect(tokens).toHaveLength(2);
    vi.mocked(livekitSession.handleVoiceToken).mockClear();
    await send(tokens[1]!.frame, {}, { n: 0 });
    await settle();
    expect(vi.mocked(livekitSession.handleVoiceToken)).toHaveBeenCalledTimes(1);
    // (token, url, channel_id, direct_url, is_key_holder): the refresh
    // reply names the room alice is in and keeps her key-holder flag.
    expect(vi.mocked(livekitSession.handleVoiceToken)).toHaveBeenCalledWith(
      expect.stringMatching(/^tok-/),
      "/livekit",
      2,
      expect.any(String),
      true,
    );
  });

  // call_incoming / call_declined are not dispatcher frames: MainPage subscribes
  // to them itself (pages/MainPage.ts), and mounting the whole page is out of
  // scope for a contract test. So these two feed the fixture's payload through
  // the same state machines MainPage hands it to (lib/voice/callRing.ts), mapping
  // the fields exactly as MainPage does with a caller no member store knows.

  it("call-ring-decline: call_incoming rings with the fixture's caller and channel", () => {
    const payload = s2cFrame("call-ring-decline", "call_incoming").payload as {
      channel_id: number;
      from_user: number;
      username: string;
    };
    expect(payload).toEqual({ channel_id: 3, from_user: 1, username: "alice" });
    const onRingStateChange = vi.fn();
    const onChime = vi.fn();
    const ring = createRingController({
      onRingStateChange,
      onChime,
      onAccept: vi.fn(),
      onDecline: vi.fn(),
    });
    ring.incoming({
      channelId: payload.channel_id,
      fromUserId: payload.from_user,
      fromUsername: payload.username,
    });
    expect(ring.current()).toEqual({ channelId: 3, fromUserId: 1, fromUsername: "alice" });
    expect(onRingStateChange).toHaveBeenCalledWith(ring.current());
    expect(onChime).toHaveBeenCalledWith(true);
    ring.destroy();
  });

  it("call-ring-decline: call_declined ends the caller's outgoing ring for the fixture's channel", () => {
    const payload = s2cFrame("call-ring-decline", "call_declined").payload as {
      channel_id: number;
      from_user: number;
      username: string;
    };
    expect(payload).toEqual({ channel_id: 3, from_user: 2, username: "bob" });
    const onChange = vi.fn();
    const outgoing = createOutgoingCall({ onChange });
    outgoing.start(payload.channel_id, [payload.from_user]);
    expect(outgoing.current()?.phase).toBe("ringing");
    outgoing.declined(payload.channel_id, payload.from_user);
    expect(outgoing.current()).toEqual({ channelId: 3, phase: "declined", pending: [] });
    outgoing.destroy();
  });

  // ─── WP 7.3b: channel, chat and admin frames ──────────────────────────────

  /** A minimal ready-channel row for seeding the channels store. */
  const readyChannel = (id: number, name: string, extra: Record<string, unknown> = {}): never =>
    ({ id, name, type: "text", category: null, position: id, ...extra }) as never;

  /** A stored message row, shaped like the ones the edit/delete cases seed. */
  const seedRow = (id: number, channelId: number, content: string): never =>
    ({
      id,
      channel_id: channelId,
      user: { id: 1, username: "alice", avatar: null, role: "member" },
      content,
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-09-05 11:00:00",
    }) as never;

  it("chat-forward-pin: the forward is a chat_message in the target DM and carries its source", async () => {
    await dispatch("chat-forward-pin", "chat_message");
    const forwarded = getChannelMessages(3).find((m) => m.content === "message to forward");
    expect(forwarded).toBeDefined();
    expect(forwarded?.user.username).toBe("alice");
    expect(forwarded?.forward).toMatchObject({ source_timestamp: "2026-09-05 12:00:00" });
  });

  it("chat-forward-pin: the forward session sends the fixture's chat_forward shape and settles on its chat_forward_ok", async () => {
    const sentFrame = fixture("chat-forward-pin").connections["a"]!.find(
      (f) => f.dir === "c2s" && f.frame.type === "chat_forward",
    )!.frame;
    const wsMock = createMockWsClient();
    wsMock.connect();
    const abort = new AbortController();
    const session = createForwardSession({
      ws: wsMock,
      sourceMessageId: 900,
      channelIds: [3],
      comment: "",
      onChange: () => undefined,
      signal: abort.signal,
    });
    const done = session.start();
    await vi.advanceTimersByTimeAsync(0);
    const out = wsMock.getSentMessages() as unknown as {
      type: string;
      id: string;
      payload: Record<string, unknown>;
    }[];
    expect(out).toHaveLength(1);
    // The client sends exactly the fields the server recorded receiving.
    expect(Object.keys(out[0]!.payload).sort()).toEqual(
      Object.keys(sentFrame.payload as Record<string, unknown>).sort(),
    );
    // The recorded reply, with the ids the session actually sent.
    const reply = s2cFrame("chat-forward-pin", "chat_forward_ok");
    wsMock.simulateMessage(
      "chat_forward_ok",
      substitute(
        reply.payload,
        { client_message_id: out[0]!.payload["client_message_id"] },
        { n: 0 },
      ) as never,
      out[0]!.id,
    );
    await done;
    expect(session.results().map((r) => r.status)).toEqual(["sent"]);
    abort.abort();
  });

  it("chat-forward-pin: chat_pinned sets then clears the pin on the fixture's channel", async () => {
    const MESSAGE_ID = 5100;
    setMessages(1, [seedRow(MESSAGE_ID, 1, "message to forward")], false);
    const pinned = (): boolean | undefined =>
      getChannelMessages(1).find((m) => m.id === MESSAGE_ID)?.pinned;
    const frames = s2cFrames("chat-forward-pin", "chat_pinned");
    expect(frames).toHaveLength(4); // pin + unpin, seen by each of the two sockets
    await send(frames[0]!, { message_id: MESSAGE_ID }, { n: 0 });
    expect(pinned()).toBe(true);
    await send(frames[1]!, { message_id: MESSAGE_ID }, { n: 0 });
    expect(pinned()).toBe(false);
  });

  // ── chat-poll (WP 6.9b) ──────────────────────────────────────────────────
  // The fixture masks every id as a placeholder, so the answers of the poll and
  // the counts of its updates would get unrelated numbers. These helpers pin
  // them to 1 and 2, as the server numbers answers, and the viewer's id.

  const POLL_MESSAGE = 5201;
  const POLL_VIEWER = 77;

  /** A fixture frame's payload with answer ids made literal (1..n in order). */
  function pollPayload(frame: WireFrame["frame"]): Record<string, unknown> {
    const payload = JSON.parse(JSON.stringify(frame.payload)) as {
      poll?: { answers: { answer_id: unknown }[]; results: { counts: { answer_id: unknown }[] } };
      counts?: { answer_id: unknown }[];
    };
    payload.poll?.answers.forEach((a, i) => (a.answer_id = i + 1));
    payload.poll?.results.counts.forEach((c, i) => (c.answer_id = i + 1));
    payload.counts?.forEach((c, i) => (c.answer_id = i + 1));
    return payload;
  }

  async function sendPoll(frame: WireFrame["frame"]): Promise<void> {
    // The viewer is the fixture's voter, so their own frames move `me`.
    if (authStore.getState().user?.id !== POLL_VIEWER) {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: POLL_VIEWER, username: "bob", avatar: null, role: "member" },
      }));
    }
    ws.simulateMessage(
      frame.type as ServerMessage["type"],
      substitute(
        pollPayload(frame),
        { message_id: POLL_MESSAGE, id: POLL_MESSAGE, user_id: POLL_VIEWER },
        { n: 0 },
      ) as never,
    );
    await vi.dynamicImportSettled();
  }

  const pollRow = () => getChannelMessages(1).find((m) => m.id === POLL_MESSAGE);

  /** Connection a's poll frames: the creation, then the four updates. */
  const pollFrames = (): { create: WireFrame["frame"]; updates: WireFrame["frame"][] } => ({
    create: s2c("chat-poll", "a").find((f) => f.frame.type === "chat_message")!.frame,
    updates: s2c("chat-poll", "a")
      .filter((f) => f.frame.type === "poll_update")
      .map((f) => f.frame),
  });

  it("chat-poll: the creation frame is a poll message with the fallback text and zeroed results", async () => {
    await sendPoll(pollFrames().create);
    const row = pollRow();
    expect(row).toBeDefined();
    expect(row?.content).toBe("\u{1F4CA} Lunch?\n- \u{1F355} Pizza\n- Sushi");
    expect(row?.mentions).toEqual([]);
    expect(row?.poll).toMatchObject({
      question: "Lunch?",
      allow_multiselect: false,
      ended: false,
      ended_at: null,
      answers: [
        { answer_id: 1, text: "Pizza", emoji: "\u{1F355}" },
        { answer_id: 2, text: "Sushi", emoji: null },
      ],
      results: { version: 0, total_voters: 0, me: [] },
      selfVersion: 0,
    });
  });

  it("chat-poll: the updates in recorded order end on the final counts, the end and the viewer's last vote", async () => {
    const { create, updates } = pollFrames();
    expect(updates).toHaveLength(4);
    await sendPoll(create);
    for (const u of updates) await sendPoll(u);
    const poll = pollRow()!.poll!;
    expect(poll.results.version).toBe(4);
    expect(poll.results.counts).toEqual([
      { answer_id: 1, count: 0 },
      { answer_id: 2, count: 1 },
    ]);
    expect(poll.results.total_voters).toBe(1);
    expect(poll.ended).toBe(true);
    expect(poll.ended_at).not.toBeNull();
    // v1 voted [1], v2 removed, v3 voted [2]; the end names no one.
    expect(poll.results.me).toEqual([2]);
    expect(poll.selfVersion).toBe(3);
  });

  it("chat-poll: any arrival order gives the same final poll", async () => {
    const { create, updates } = pollFrames();
    for (const order of [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]) {
      resetMessagesStore();
      await sendPoll(create);
      for (const i of order) await sendPoll(updates[i]!);
      const poll = pollRow()!.poll!;
      expect(poll.results.version, `order ${order.join(",")}`).toBe(4);
      expect(poll.ended, `order ${order.join(",")}`).toBe(true);
      expect(poll.results.me, `order ${order.join(",")}`).toEqual([2]);
    }
  });

  it("chat-poll: a replayed creation frame never rolls the counts back", async () => {
    const { create, updates } = pollFrames();
    await sendPoll(create);
    for (const u of updates) await sendPoll(u);
    await sendPoll(create);
    const poll = pollRow()!.poll!;
    expect(poll.results.version).toBe(4);
    expect(poll.ended).toBe(true);
    expect(poll.results.me).toEqual([2]);
  });

  it("chat-poll: the voter's poll_vote_ok shows their selection before the counts arrive", async () => {
    await sendPoll(pollFrames().create);
    await sendPoll(s2c("chat-poll", "b").find((f) => f.frame.type === "poll_vote_ok")!.frame);
    const poll = pollRow()!.poll!;
    expect(poll.results.me).toEqual([1]);
    expect(poll.selfVersion).toBe(1);
    expect(poll.results.version).toBe(0);
  });

  it("chat-poll: an update for a message that is not loaded is dropped", async () => {
    await sendPoll(pollFrames().updates[0]!);
    expect(pollRow()).toBeUndefined();
    expect(getChannelMessages(1)).toHaveLength(0);
  });

  it("chat-poll: the poll requests send exactly the fixture's fields and settle on its replies", async () => {
    const wsMock = createMockWsClient();
    wsMock.connect();
    const sentOf = () =>
      wsMock.getSentMessages() as unknown as {
        type: string;
        id: string;
        payload: Record<string, unknown>;
      }[];
    const recorded = (conn: string, type: string): WireFrame["frame"] =>
      fixture("chat-poll").connections[conn]!.find((f) => f.dir === "c2s" && f.frame.type === type)!
        .frame;
    const keys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();

    const created = createPoll(wsMock, {
      channelId: 1,
      question: "Lunch?",
      answers: [{ text: "Pizza", emoji: "\u{1F355}" }, { text: "Sushi" }],
      durationHours: 24,
      allowMultiselect: false,
      clientMessageId: "cmid-contract",
    });
    await vi.advanceTimersByTimeAsync(0);
    const create = recorded("a", "poll_create").payload as Record<string, unknown>;
    expect(keys(sentOf()[0]!.payload)).toEqual(keys(create));
    expect(sentOf()[0]!.payload).toMatchObject({
      question: create["question"],
      answers: create["answers"],
      duration_hours: create["duration_hours"],
      allow_multiselect: create["allow_multiselect"],
    });
    wsMock.simulateMessage(
      "poll_create_ok",
      substitute(
        s2cFrame("chat-poll", "poll_create_ok").payload,
        { client_message_id: "cmid-contract" },
        { n: 0 },
      ) as never,
      sentOf()[0]!.id,
    );
    await expect(created).resolves.toMatchObject({ ok: true });

    const voted = votePoll(wsMock, POLL_MESSAGE, [1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(sentOf()[1]!.payload)).toEqual(keys(recorded("b", "poll_vote").payload));
    wsMock.simulateMessage(
      "poll_vote_ok",
      substitute(
        s2cFrame("chat-poll", "poll_vote_ok").payload,
        { message_id: POLL_MESSAGE },
        { n: 0 },
      ) as never,
      sentOf()[1]!.id,
    );
    await expect(voted).resolves.toMatchObject({ ok: true, value: { version: 1 } });

    const ended = endPoll(wsMock, POLL_MESSAGE);
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(sentOf()[2]!.payload)).toEqual(keys(recorded("a", "poll_end").payload));
    wsMock.simulateMessage(
      "poll_end_ok",
      substitute(
        s2cFrame("chat-poll", "poll_end_ok").payload,
        { message_id: POLL_MESSAGE },
        { n: 0 },
      ) as never,
      sentOf()[2]!.id,
    );
    await expect(ended).resolves.toMatchObject({ ok: true });
  });

  it("chat-bulk-delete: one frame removes every id it lists", async () => {
    const ids = (s2cFrame("chat-bulk-delete", "chat_bulk_deleted").payload as { ids: number[] })
      .ids;
    expect(ids).toEqual([1, 2, 3]);
    setMessages(
      1,
      [...ids, 99].map((id) => seedRow(id, 1, `row ${id}`)),
      false,
    );
    await dispatch("chat-bulk-delete", "chat_bulk_deleted");
    const rows = new Map(getChannelMessages(1).map((m) => [m.id, m]));
    for (const id of ids) {
      expect(rows.get(id) === undefined || rows.get(id)?.deleted === true, `id ${id}`).toBe(true);
    }
    expect(rows.get(99)?.deleted).toBe(false);
  });

  it("mention-count-nsfw-ack: mention_count sets the fixture channel's badge to the frame's total", async () => {
    setChannels([readyChannel(1, "general")]);
    await dispatch("mention-count-nsfw-ack", "mention_count");
    expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(2);
  });

  it("mention-count-nsfw-ack: nsfw_ack acknowledges then revokes the labelled channel", async () => {
    setChannels([readyChannel(3, "adults", { nsfw: true })]);
    const acknowledged = (): boolean | undefined =>
      channelsStore.getState().channels.get(3)?.nsfwAcknowledged;
    expect(acknowledged()).toBe(false);
    const [grant, revoke] = s2cFrames("mention-count-nsfw-ack", "nsfw_ack");
    await send(grant!, {}, { n: 0 });
    expect(acknowledged()).toBe(true);
    await send(revoke!, {}, { n: 0 });
    expect(acknowledged()).toBe(false);
  });

  it("chat-command-unknown: the refusal reaches the user as a toast with the server's text", async () => {
    vi.mocked(showToast).mockClear();
    await dispatch("chat-command-unknown", "error");
    expectConsole("error", "Server error");
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    const [text, kind] = vi.mocked(showToast).mock.calls[0]!;
    expect(text).toBe("Unknown command: /nosuchcommand (no plugins loaded)");
    expect(kind).toBe("error");
  });

  it("channel-crud: create adds the channel with this viewer's verdicts, update edits it, delete removes it", async () => {
    const CHANNEL_ID = 5200;
    const counter = { n: 0 };
    const [create] = s2c("channel-crud", "a").filter((f) => f.frame.type === "channel_create");
    await send(create!.frame, { id: CHANNEL_ID }, counter);
    expect(channelsStore.getState().channels.get(CHANNEL_ID)).toMatchObject({
      name: "announcements",
      category: "Info",
      topic: "fixture topic",
      canSend: true,
      canPin: false,
      canReact: true,
      slowMode: 0,
    });
    const [update] = s2c("channel-crud", "a").filter((f) => f.frame.type === "channel_update");
    await send(update!.frame, { id: CHANNEL_ID }, counter);
    expect(channelsStore.getState().channels.get(CHANNEL_ID)).toMatchObject({
      name: "news",
      topic: "edited topic",
      slowMode: 10,
    });
    const [del] = s2c("channel-crud", "a").filter((f) => f.frame.type === "channel_delete");
    await send(del!.frame, { id: CHANNEL_ID }, counter);
    expect(channelsStore.getState().channels.has(CHANNEL_ID)).toBe(false);
  });

  it("dm-open-close: dm_channel_open lists the DM with its partner, dm_channel_close drops it", async () => {
    await dispatch("dm-open-close", "dm_channel_open");
    const dm = dmStore.getState().channels.find((c) => c.channelId === 3);
    expect(dm?.recipient.username).toBe("alice");
    expect(dm?.isGroup).toBe(false);
    await dispatch("dm-open-close", "dm_channel_close");
    expect(dmStore.getState().channels.some((c) => c.channelId === 3)).toBe(false);
  });

  it("server-admin-broadcasts: emoji_update replaces the custom-emoji set", async () => {
    await dispatch("server-admin-broadcasts", "emoji_update");
    expect(emojiStore.getState().emoji.map((e) => e.shortcode)).toEqual(["fixture"]);
    expect(emojiStore.getState().byShortcode.get("fixture")?.url).toBe("/api/v1/emoji/1/image");
  });

  it("server-admin-broadcasts: upload_policy replaces both file-type lists", async () => {
    await dispatch("server-admin-broadcasts", "upload_policy");
    expect(authStore.getState().uploadPolicy).toMatchObject({
      blocked_extensions: ["bat", "exe"],
      allowed_extensions: [],
    });
  });

  it("server-admin-broadcasts: server_restart announces the drop and opens the rejoin window", () => {
    const clock: ReconnectClock = {
      hasAuthenticatedBefore: false,
      hasReceivedReadyBefore: false,
      lastReconnectHandshakeAt: null,
      serverClockSkewMs: 0,
      restartAnnounced: false,
      voiceRejoinChannelId: null,
      voiceRejoinExpiresAt: null,
    };
    const payload = s2cFrame("server-admin-broadcasts", "server_restart").payload as Parameters<
      typeof handleServerRestart
    >[1];
    expect(payload).toMatchObject({ reason: "update", delay_seconds: 30 });
    expect(typeof payload.reconnect_spread_ms).toBe("number");
    handleServerRestart(clock, payload);
    expectConsole("warn", "Server restarting");
    expect(clock.restartAnnounced).toBe(true);
    expect(clock.voiceRejoinExpiresAt).not.toBeNull();
  });

  it("server-admin-broadcasts: presence updates the member's status and custom text", async () => {
    const USER_ID = 8101;
    setMembers([
      {
        id: USER_ID,
        username: "alice",
        avatar: null,
        role: "member",
        status: "online",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
    ]);
    await dispatch("server-admin-broadcasts", "presence", { user_id: USER_ID });
    expect(membersStore.getState().members.get(USER_ID)).toMatchObject({
      status: "idle",
      customStatus: "fixture custom status",
    });
  });

  it("moderation-queue: mod_queue bumps the report signal for a report and the appeal signal for an appeal", async () => {
    const frames = s2c("moderation-queue", "a").filter((f) => f.frame.type === "mod_queue");
    const reportFrame = frames.find(
      (f) => (f.frame.payload as { report_id?: string }).report_id !== undefined,
    )!;
    const appealFrames = frames.filter(
      (f) => (f.frame.payload as { appeal_id?: string }).appeal_id !== undefined,
    );
    expect(appealFrames).toHaveLength(3);
    const reports = modQueueStore.getState();
    const appeals = modAppealStore.getState();
    await send(reportFrame.frame, {}, { n: 0 });
    expect(modQueueStore.getState()).toBe(reports + 1);
    expect(modAppealStore.getState()).toBe(appeals);
    for (const f of appealFrames) await send(f.frame, {}, { n: 0 });
    expect(modAppealStore.getState()).toBe(appeals + 3);
    expect(modQueueStore.getState()).toBe(reports + 1);
  });

  it("moderation-queue: mod_action shows the warning once, with the fixture's reason", async () => {
    vi.mocked(showToast).mockClear();
    await dispatch("moderation-queue", "mod_action", { id: 5300 });
    expect(safetyStore.getState().notices.map((n) => n.reason)).toEqual(["fixture warning"]);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.stringContaining("fixture warning"),
      "warning",
    );
  });

  it("moderation-queue: appeal_status carries the appeal through assigned to the decision", async () => {
    const APPEAL_ID = "appeal-5400";
    safetyStore.setState((prev) => ({
      ...prev,
      appeals: [
        { id: APPEAL_ID, state: "open", decision_note: null, created_at: "2026-09-05 11:00:00" },
      ] as never,
    }));
    const frames = s2c("moderation-queue", "b").filter((f) => f.frame.type === "appeal_status");
    expect(frames).toHaveLength(2);
    const stateNow = (): { state?: string; decision_note?: string | null } | undefined =>
      (
        safetyStore.getState().appeals as
          readonly { id: string; state: string; decision_note: string | null }[] | null
      )?.find((a) => a.id === APPEAL_ID);
    await send(frames[0]!.frame, { id: APPEAL_ID }, { n: 0 });
    expect(stateNow()).toMatchObject({ state: "assigned", decision_note: null });
    await send(frames[1]!.frame, { id: APPEAL_ID }, { n: 0 });
    expect(stateNow()).toMatchObject({ state: "overturned", decision_note: "fixture decision" });
  });

  /** A roster entry for the member-frame tests below: the fixture does not
   *  keep ids stable, so each test seeds the member it patches. */
  function seedMember(id: number, username: string, role: string): void {
    setMembers([
      {
        id,
        username,
        avatar: null,
        role,
        status: "online",
        display_name: null,
        custom_status: null,
        identity_public_key: "pinned-key",
      },
    ]);
  }

  it("role-change: member_update regroups the member, promotion then demotion", async () => {
    const USER_ID = 8201;
    seedMember(USER_ID, "bob", "Member");
    const [promote, demote] = s2c("role-change", "a").filter(
      (f) => f.frame.type === "member_update",
    );
    expect(promote?.frame.payload).toMatchObject({ role: "Moderator" });
    await send(promote!.frame, { user_id: USER_ID }, { n: 0 });
    expect(membersStore.getState().members.get(USER_ID)?.role).toBe("Moderator");
    await send(demote!.frame, { user_id: USER_ID }, { n: 0 });
    expect(membersStore.getState().members.get(USER_ID)?.role).toBe("Member");
  });

  it("role-change: member_timeouts replaces the target's list wholesale, full then own-only", async () => {
    // bob becomes a moderator (the full list, empty here) and is then demoted
    // (his own-only list, replacing it): both are the same frame shape.
    const frames = s2c("role-change", "b").filter((f) => f.frame.type === "member_timeouts");
    expect(frames).toHaveLength(2);
    setMemberTimeouts([{ user_id: 77, expires_at: "2099-01-01T00:00:00Z" }]);
    for (const f of frames) {
      await send(f.frame, {}, { n: 0 });
      expect(memberTimeoutsStore.getState()).toEqual(new Map());
    }
  });

  it("role-edit: roles_update replaces the role list, colour edit then rename and permissions", async () => {
    const frames = s2c("role-edit", "a").filter((f) => f.frame.type === "roles_update");
    expect(frames).toHaveLength(2);
    await send(frames[0]!.frame, {}, { n: 0 });
    const afterColour = channelsStore.getState().roles.find((r) => r.is_default);
    expect(afterColour).toMatchObject({ name: "Member", color: "#3366CC" });
    await send(frames[1]!.frame, {}, { n: 0 });
    const afterEdit = channelsStore.getState().roles.find((r) => r.is_default);
    expect(afterEdit?.name).toBe("Regular");
    // SEND_MESSAGES (bit 0) is the bit the second edit removed.
    expect(afterEdit!.permissions & 1).toBe(0);
    expect(afterColour!.permissions & 1).toBe(1);
    expect(channelsStore.getState().roles).toHaveLength(4);
  });

  it("role-edit: member_update re-keys the holder to the renamed role", async () => {
    const USER_ID = 8211;
    seedMember(USER_ID, "bob", "Member");
    await dispatch("role-edit", "member_update", { user_id: USER_ID });
    expect(membersStore.getState().members.get(USER_ID)?.role).toBe("Regular");
  });

  it("user-update: the populated form sets every profile field, the sparse form clears them", async () => {
    const ALICE_ID = 8301;
    const BOB_ID = 8302;
    setMembers([
      {
        id: ALICE_ID,
        username: "alice",
        avatar: null,
        role: "Admin",
        status: "online",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
      {
        id: BOB_ID,
        username: "bob",
        avatar: "https://old.invalid/bob.png",
        role: "Member",
        status: "online",
        display_name: null,
        custom_status: null,
        identity_public_key: "bob-pinned-key",
        about: "old about",
      } as never,
    ]);
    const [full, sparse] = s2c("user-update", "b").filter((f) => f.frame.type === "user_update");
    await send(full!.frame, { user_id: ALICE_ID }, { n: 0 });
    expect(membersStore.getState().members.get(ALICE_ID)).toMatchObject({
      username: "alice",
      avatar: "https://fixtures.invalid/alice-avatar.png",
      displayName: "Alice Fixture",
      identityPublicKey: "YWxpY2UtaWRlbnRpdHktcHVibGljLWtleS1maXh0dXJl",
      about: "edited fixture profile text",
      banner_color: "#112233",
    });
    await send(sparse!.frame, { user_id: BOB_ID }, { n: 0 });
    const bob = membersStore.getState().members.get(BOB_ID);
    expect(bob).toMatchObject({ username: "bob", avatar: null, displayName: "Bob Fixture" });
    expect((bob as { about?: string | null }).about).toBeNull();
    // The sparse frame omits identity_public_key: an absent key leaves the
    // pinned one alone, where an explicit null would clear it.
    expect(bob?.identityPublicKey).toBe("bob-pinned-key");
  });

  it("member-ban: member_ban drops the banned member from the roster", async () => {
    const CAROL_ID = 8401;
    const ALICE_ID = 8402;
    setMembers([
      {
        id: CAROL_ID,
        username: "carol",
        avatar: null,
        role: "Member",
        status: "offline",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
      {
        id: ALICE_ID,
        username: "alice",
        avatar: null,
        role: "Admin",
        status: "online",
        display_name: null,
        custom_status: null,
        identity_public_key: null,
      },
    ]);
    const [carolBan, bobBan] = s2c("member-ban", "a").filter((f) => f.frame.type === "member_ban");
    await send(carolBan!.frame, { user_id: CAROL_ID }, { n: 0 });
    expect([...membersStore.getState().members.keys()]).toEqual([ALICE_ID]);
    // A ban of a user the client does not hold is a no-op, not a throw.
    await send(bobBan!.frame, { user_id: 8499 }, { n: 0 });
    expect([...membersStore.getState().members.keys()]).toEqual([ALICE_ID]);
  });

  it("member-ban: the banned socket's error frame carries the BANNED code", async () => {
    const errFrame = s2cFrame("member-ban", "error");
    expect(errFrame.payload).toMatchObject({ code: "BANNED", message: "you are banned" });
    await send(errFrame, {}, { n: 0 });
    expectConsole("error", "Server error");
  });

  it("member-timeout: mod_action with expires_at starts the timeout, the lift clears it", async () => {
    vi.mocked(showToast).mockClear();
    const EXPIRES_AT = "2099-01-01T00:00:00Z";
    const [issued, lifted] = s2c("member-timeout", "b").filter(
      (f) => f.frame.type === "mod_action",
    );
    expect(issued?.frame.payload).toMatchObject({ kind: "timeout", reason: "fixture timeout" });
    await send(issued!.frame, { id: 5500, expires_at: EXPIRES_AT }, { n: 0 });
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: EXPIRES_AT });
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.any(String), "warning");
    expect(lifted?.frame.payload).toMatchObject({ kind: "timeout", expires_at: "<ts:null>" });
    await send(lifted!.frame, { id: 5501 }, { n: 0 });
    expect(safetyStore.getState().timeout).toBeNull();
  });

  it("member-timeout: member_timeouts is the moderator's full list, then empty after the lift", async () => {
    const TARGET_ID = 8501;
    const EXPIRES_AT = "2099-01-01T00:00:00Z";
    const [issued, lifted] = s2c("member-timeout", "a").filter(
      (f) => f.frame.type === "member_timeouts",
    );
    await send(issued!.frame, { user_id: TARGET_ID, expires_at: EXPIRES_AT }, { n: 0 });
    expect(memberTimeoutsStore.getState()).toEqual(new Map([[TARGET_ID, EXPIRES_AT]]));
    await send(lifted!.frame, {}, { n: 0 });
    expect(memberTimeoutsStore.getState()).toEqual(new Map());
  });

  it("member-timeout: the re-sent channel_create flips can_send off and back on", async () => {
    const creates = s2c("member-timeout", "b").filter(
      (f) =>
        f.frame.type === "channel_create" &&
        (f.frame.payload as { name: string }).name === "general",
    );
    expect(creates).toHaveLength(2);
    await send(creates[0]!.frame, { id: 1 }, { n: 0 });
    expect(channelsStore.getState().channels.get(1)?.canSend).toBe(false);
    await send(creates[1]!.frame, { id: 1 }, { n: 0 });
    expect(channelsStore.getState().channels.get(1)?.canSend).toBe(true);
  });

  it("every fixture connection replays end to end without a handler throw", async () => {
    for (const [journey, tr] of FIXTURES) {
      for (const conn of Object.keys(tr.connections)) {
        cleanup?.();
        resetStores();
        ws = createMockWsClient();
        cleanup = wireDispatcher(ws as unknown as WsClient);
        await expect(
          replayConnection(journey, conn),
          `${journey}/${conn}`,
        ).resolves.toBeUndefined();
        // auth-failure is the one journey whose handler deliberately logs an
        // error; claim it so the console guard does not fail the run.
        if (journey === "auth-failure") expectConsole("error", "Auth failed");
        // voice-mod-denied's error frame is logged by the same handler.
        if (journey === "voice-mod-denied" && conn === "b") expectConsole("error", "Server error");
        // server_restart is logged as a warning by its handler.
        if (journey === "server-admin-broadcasts") expectConsole("warn", "Server restarting");
        // chat-command-unknown's refusal is logged by the same handler.
        if (journey === "chat-command-unknown" && conn === "a")
          expectConsole("error", "Server error");
        // member-ban's BANNED error on the banned socket, same handler.
        if (journey === "member-ban" && conn === "b") expectConsole("error", "Server error");
      }
    }
  });

  it("every fixture's timestamp placeholders are typed, never a bare <ts>", () => {
    const tsValues: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        if (v.startsWith("<ts")) tsValues.push(v);
        return;
      }
      if (Array.isArray(v)) return v.forEach(walk);
      if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    for (const tr of FIXTURES.values()) walk(tr);
    expect(tsValues.length).toBeGreaterThan(0);
    // A typed placeholder ("<ts:string>"/"<ts:null>") is what this test can
    // substitute into a real value; an untyped "<ts>" would hide the format.
    expect(tsValues.every((v) => /^<ts:(string|null)>$/.test(v))).toBe(true);
  });
});
