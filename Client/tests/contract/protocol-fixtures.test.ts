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
vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  notifyMention: vi.fn(),
  notifyChannelActivity: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
}));
vi.mock("@lib/livekitSession", () => ({
  handleVoiceToken: vi.fn(async () => {}),
  handleParticipantLeft: vi.fn(async () => {}),
  handleE2EEAnnounce: vi.fn(async () => {}),
  handleE2EEOffer: vi.fn(async () => {}),
  leaveVoice: vi.fn(),
  cleanupAll: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  isAutoReconnecting: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  disableCamera: vi.fn(async () => {}),
  disableScreenshare: vi.fn(async () => {}),
}));
vi.mock("@lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/identity", () => ({ ensureIdentityKeyPublished: vi.fn(async () => true) }));
vi.mock("@lib/screenShare", () => ({ rollbackPendingVideo: vi.fn(() => undefined) }));

vi.spyOn(console, "info").mockImplementation(() => {});

import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { expectConsole } from "../helpers/console";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, resetChannelsStore, setChannels } from "../../src/stores/channels.store";
import { membersStore, setMembers } from "../../src/stores/members.store";
import {
  addOptimisticMessage,
  getChannelMessages,
  resetMessagesStore,
  setMessages,
} from "../../src/stores/messages.store";
import { setDmChannels } from "../../src/stores/dm.store";
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
import type { ServerMessage } from "../../src/lib/types";
import { showToast } from "@lib/toast";
import * as livekitSession from "@lib/livekitSession";
import { createOutgoingCall, createRingController } from "../../src/lib/call-ring";

// ─── fixture loading ─────────────────────────────────────────────────────────

interface WireFrame {
  readonly dir: "c2s" | "s2c";
  readonly frame: { readonly type: string; readonly payload?: unknown; readonly id?: string };
}
interface WireTranscript {
  readonly journey: string;
  readonly connections: Record<string, readonly WireFrame[]>;
}

const FIXTURE_DIR = path.resolve(__dirname, "../../../protocol/fixtures/epoch-1");
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

describe("contract: epoch-1 fixtures through the client dispatcher (ARCH-02)", () => {
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
  // the same state machines MainPage hands it to (lib/call-ring.ts), mapping
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
