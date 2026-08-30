/**
 * Model-based test for the client connection stack (B3-6 item 4, Tier 3a of
 * docs/plans/bug-detection-improvements.md).
 *
 * Property tests find bad functions; every recurring bug in this codebase's
 * history is a bad *ordering* — reconnect transfer, superseded voice sessions,
 * duplicate-message reconciliation, resync corruption, the logout/auto-login
 * race. `fc.commands` generates those orderings and shrinks a long failure to
 * its minimal reproducer.
 *
 * System under test — the REAL modules, wired together the way main.ts wires
 * them: `createWsClient()` (src/lib/ws.ts) driving `wireDispatcher()`
 * (src/lib/dispatcher.ts) into the real stores. Only the boundaries are
 * mocked:
 *   - the Tauri IPC surface (`invoke`/`listen`), via the shared ws-mocks
 *     helper the ws-*.test.ts files already use — this is the wire, and
 *     driving it is the only way to exercise ws.ts's own state machine;
 *   - the LiveKit media layer, notifications, toasts and identity publishing,
 *     exactly as dispatcher.test.ts mocks them. `handleParticipantLeft` keeps
 *     its one store-visible effect (clearing the departed peer's E2EE
 *     verification) so the verification invariant stays two-sided.
 * Nothing that the invariants describe is mocked: ws.ts's seq watermark,
 * messages.store's id reconciliation, voice.store's session and verification
 * state are all the production implementations.
 *
 * Reproducing a failure: fast-check prints the seed, the counterexample and a
 * `replayPath`. Re-run with `OWNCORD_MODEL_SEED=<seed>` to replay exactly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

// vi.mock is hoisted per file; these factories resolve to the shared handles
// exported from ./helpers/ws-mocks (see that module's doc comment).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
}));
vi.mock("@lib/screenShare", () => ({
  rollbackPendingVideo: vi.fn(() => undefined),
}));
vi.mock("@lib/toast", () => ({
  showToast: vi.fn(),
}));
vi.mock("@lib/identity", () => ({
  ensureIdentityKeyPublished: vi.fn(async () => true),
}));
// The media layer is out of scope for a connection model (it needs a real
// LiveKit room and WebCrypto), but handleParticipantLeft's store-visible
// effect is not: livekitE2EE.ts drops a departed peer's verification, and the
// verification invariant below has to be able to observe that happening.
vi.mock("@lib/livekitSession", async () => {
  const { clearPeerVerification, clearPeerVerifications } = await import("@stores/voice.store");
  return {
    handleVoiceToken: vi.fn(async () => {}),
    handleParticipantLeft: vi.fn(async (userId: number) => {
      clearPeerVerification(userId);
    }),
    handleE2EEAnnounce: vi.fn(async () => {}),
    handleE2EEOffer: vi.fn(async () => {}),
    leaveVoice: vi.fn(() => {
      clearPeerVerifications();
    }),
    cleanupAll: vi.fn(),
    isVoiceConnected: vi.fn(() => false),
    isVoiceSessionActive: vi.fn(() => false),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    disableCamera: vi.fn(async () => {}),
    disableScreenshare: vi.fn(async () => {}),
  };
});

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient, type WsClient } from "../../src/lib/ws";
import { wireDispatcher, type DispatcherCleanup } from "../../src/lib/dispatcher";
import { clearAuth } from "../../src/stores/auth.store";
import { getChannelMessages } from "../../src/stores/messages.store";
import { voiceStore, setPeerVerification } from "../../src/stores/voice.store";
import type {
  AuthOkPayload,
  ChatMessagePayload,
  ReadyPayload,
  ReadyVoiceState,
  VoiceStatePayload,
} from "../../src/lib/types";

const HOST = "localhost:8443";
const TOKEN = "test-token";
const TEXT_CHANNEL = 1;
/** The two voice channels a Supersede can move between. */
const VOICE_CHANNELS = [10, 11] as const;
const SELF_ID = 1;
const PEER_IDS = [2, 3] as const;
/** Small id pool so redelivery collisions happen by construction. */
const MESSAGE_IDS = { min: 1, max: 6 } as const;

/**
 * Minimal reference implementation of the expected state — deliberately NOT a
 * second copy of the real logic: a handful of scalars the commands maintain by
 * hand, which is what makes a disagreement meaningful.
 */
interface Model {
  /** Socket open AND authenticated (auth_ok seen). */
  connected: boolean;
  /** The seq watermark ws.ts must declare in the next auth frame. */
  seq: number;
  /** Message ids the store must hold for TEXT_CHANNEL, in arrival order. */
  ids: number[];
  /** The voice channel the newest join owns, or null. */
  voiceChannel: number | null;
  /**
   * Peers in that voice channel whose E2EE identity is verified. In this model
   * a peer in our call is exactly a verified peer — the announce/TOFU crypto
   * itself belongs to livekitE2EE's own tests, not to a connection model.
   */
  verifiedPeers: number[];
}

interface Real {
  readonly client: WsClient;
  readonly cleanup: DispatcherCleanup;
  /** Every envelope handed to the Tauri `ws_send` command, newest last. */
  readonly sent: Array<{ type?: string; payload?: Record<string, unknown> }>;
}

/**
 * Which invariant families the generated sequences actually reached. Asserted
 * at the end of the file: a family that stops being reachable (a `check()`
 * that can no longer fire, a payload the dispatcher starts ignoring) is a
 * silent hole, not a pass.
 */
const exercised = { ids: 0, seq: 0, verified: 0, staleTeardown: 0, resumeReplay: 0 };

/** Let the ws client's awaits and the dispatcher's lazy imports settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

function emit(type: string, payload: unknown, seq?: number): void {
  emitTauriEvent(
    "ws-message",
    JSON.stringify(seq === undefined ? { type, payload } : { type, payload, seq }),
  );
}

function member(id: number, username: string) {
  return { id, username, avatar: null, role: "member", status: "online" as const };
}

function authOkPayload(replaySource: "none" | "buffer"): AuthOkPayload {
  return {
    user: { id: SELF_ID, username: "me", avatar: null, role: "member" },
    server_name: "test",
    motd: "",
    replay_source: replaySource,
  };
}

/**
 * The message a resume replays: one that committed while we were away, or —
 * once the id pool is exhausted — a redelivery of one we already hold, which
 * is the other real shape a replay burst takes.
 */
function replayedMessageId(m: Model): number {
  for (let id = MESSAGE_IDS.min; id <= MESSAGE_IDS.max; id++) {
    if (!m.ids.includes(id)) return id;
  }
  return m.ids[m.ids.length - 1] as number;
}

function chatPayload(id: number): ChatMessagePayload {
  return {
    id,
    channel_id: TEXT_CHANNEL,
    user: { id: PEER_IDS[0], username: "peer2", avatar: null },
    content: `message ${id}`,
    reply_to: null,
    attachments: [],
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function voiceState(channelId: number, userId: number): VoiceStatePayload {
  return {
    channel_id: channelId,
    user_id: userId,
    username: userId === SELF_ID ? "me" : `peer${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };
}

/** The `ready` snapshot a server would build for this model state. */
function readyPayload(m: Model, dropPeers: readonly number[] = []): ReadyPayload {
  const voiceChannel = m.voiceChannel;
  const roster: ReadyVoiceState[] =
    voiceChannel === null
      ? []
      : [SELF_ID, ...m.verifiedPeers.filter((uid) => !dropPeers.includes(uid))].map((uid) => ({
          channel_id: voiceChannel,
          user_id: uid,
          muted: false,
          deafened: false,
        }));
  return {
    channels: [
      {
        id: TEXT_CHANNEL,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        last_message_id: m.ids.length > 0 ? Math.max(...m.ids) : 0,
      },
    ],
    members: [member(SELF_ID, "me"), ...PEER_IDS.map((id) => member(id, `peer${id}`))],
    voice_states: roster,
    roles: [],
    dm_channels: [],
  };
}

/** The peers the real store currently reports as verified, sorted. */
function realVerifiedPeers(): number[] {
  const verifications = voiceStore.getState().peerVerifications;
  return [...(verifications?.values() ?? [])]
    .filter((v) => v.status === "verified")
    .map((v) => v.userId)
    .toSorted((a, b) => a - b);
}

/**
 * The four invariants from the design, checked after every command so
 * shrinking lands on the first step that broke one.
 */
function checkInvariants(m: Model, r: Real, afterSeeding = false): void {
  // 1. Message ids never duplicate, and the store holds exactly the ids the
  //    connection delivered — a redelivery reconciles in place, it does not
  //    add a row, and a resync does not lose one.
  const ids = getChannelMessages(TEXT_CHANNEL).map((row) => row.id);
  expect(new Set(ids).size, `duplicate message ids: ${ids.join(",")}`).toBe(ids.length);
  expect(ids).toEqual(m.ids);
  if (m.ids.length > 0) exercised.ids++;

  // 2. Per-client seq is monotonic. Not checked here: the watermark is only
  //    observable when ws.ts puts it on the wire, so the assertion lives in
  //    `connectCmd` against that connect's own auth frame. Anything asserted
  //    here would only be the model against itself.

  // 3. A verified peer never flips to unverified (and back). The model is the
  //    arbiter: a peer stays verified until it genuinely leaves our call, and
  //    a re-join re-verifies — anything else is a flip. `afterSeeding` marks
  //    the one call that runs immediately after Supersede wrote the
  //    verifications itself: it still asserts, but it must not count as
  //    coverage, or the family would look reached even if every check that
  //    survives a later command disappeared.
  expect(realVerifiedPeers()).toEqual(m.verifiedPeers.toSorted((a, b) => a - b));
  if (m.verifiedPeers.length > 0 && !afterSeeding) exercised.verified++;

  // 4. An aborted attempt never tears down a live session owned by a newer
  //    attempt: the store's voice session always belongs to the newest join.
  expect(voiceStore.getState().currentChannelId).toBe(m.voiceChannel);

  // The transport must never be left in a state nobody asked for.
  expect(["disconnected", "connecting", "authenticating", "connected", "reconnecting"]).toContain(
    r.client.getState(),
  );
}

type Cmd = fc.AsyncCommand<Model, Real>;

function cmd(
  name: string,
  check: (m: Model) => boolean,
  run: (m: Model, r: Real) => Promise<void>,
): Cmd {
  return { check, run, toString: () => name };
}

/**
 * Connect: open the socket, hand over the auth frame, complete the handshake.
 *
 * The handshake has two shapes on the wire, and they are not interchangeable
 * (`Server/ws/serve.go`; the epoch-1 fixtures record both):
 *  - fresh / full-resync fallback (`last_seq` 0, or replay refused):
 *    `handleFreshConnect` writes `auth_ok` with `replay_source: "none"`
 *    followed by `ready` — `fresh-connect.json` records exactly that.
 *  - resume (`last_seq > 0`, replay accepted): `reconnectWriteReplay` writes
 *    `auth_ok` with the tier, then the missed events, and **no `ready` at
 *    all** — `resume-replay.json` records `auth_ok(buffer)` → `presence` →
 *    `chat_message` → `presence`.
 * Modelling a resume as `auth_ok` + `ready` (as this did before) meant the
 * dispatcher never saw the `auth_ok → replayed events` ordering, and the
 * post-resume state was repaired by a snapshot that never arrives.
 */
const connectCmd = cmd(
  "Connect",
  (m) => !m.connected,
  async (m, r) => {
    // Only frames sent by THIS attempt count — an earlier attempt's auth frame
    // must never be mistaken for one this connect produced.
    const before = r.sent.length;
    r.client.connect({ host: HOST, token: TOKEN });
    await settle();
    emitTauriEvent("ws-state", "open");
    await settle();

    // Invariant 2's only real assertion point: the auth frame is where the seq
    // watermark becomes observable. A fresh connect declares 0 and proves
    // nothing, so only a resume (`m.seq > 0`, i.e. frames survived a
    // Disconnect without a resync or logout in between) counts as coverage.
    const resume = m.seq > 0;
    const auth = r.sent.slice(before).find((e) => e.type === "auth");
    expect(auth, "connect sent no auth frame").toBeDefined();
    expect(auth?.payload?.last_seq).toBe(m.seq);
    if (resume) exercised.seq++;

    emit("auth_ok", authOkPayload(resume ? "buffer" : "none"));
    const replayId = resume ? replayedMessageId(m) : null;
    if (replayId === null) {
      emit("ready", readyPayload(m));
    } else {
      emit("chat_message", chatPayload(replayId), m.seq + 1);
    }
    await settle();

    m.connected = true;
    if (replayId !== null) {
      m.seq += 1;
      if (!m.ids.includes(replayId)) m.ids.push(replayId);
      // The replay burst is the only thing that repairs this client's state —
      // no `ready` follows it — so the frame has to be in the store already.
      // Re-adding a `ready` here would let a snapshot do that repair instead,
      // which is the shape this test must not silently accept.
      expect(getChannelMessages(TEXT_CHANNEL).map((row) => row.id)).toContain(replayId);
      exercised.resumeReplay++;
    }
    expect(r.client.getState()).toBe("connected");
    checkInvariants(m, r);
  },
);

/** Disconnect: the proxy drops the socket. Automatic reconnect keeps lastSeq. */
const disconnectCmd = cmd(
  "Disconnect",
  (m) => m.connected,
  async (m, r) => {
    emitTauriEvent("ws-state", "closed");
    await settle();

    m.connected = false;
    expect(r.client.getState()).toBe("reconnecting");
    checkInvariants(m, r);
  },
);

/**
 * RegisterNow: the server registered this connection and then built `ready`.
 * A message that committed in between is in the snapshot AND is redelivered as
 * a queued frame — the redelivery must reconcile, not duplicate.
 *
 * `ready` never travels alone: `handleFreshConnect` is its only writer and it
 * always follows that path's `auth_ok`, so this drives the full handshake.
 * `replay_source: "none"` resets ws.ts's watermark, and the redelivered frame
 * then carries the server's restarted counter (OC-0032).
 */
const registerNowCmd = cmd(
  "RegisterNow",
  (m) => m.connected && m.ids.length > 0,
  async (m, r) => {
    emit("auth_ok", authOkPayload("none"));
    emit("ready", readyPayload(m));
    emit("chat_message", chatPayload(m.ids[m.ids.length - 1] as number), 1);
    await settle();

    m.seq = 1;
    checkInvariants(m, r);
  },
);

/** Receive(id, seq): a sequenced frame off the wire. */
function receiveCmd(id: number, seq: number): Cmd {
  return cmd(
    `Receive(id=${id},seq=${seq})`,
    (m) => m.connected,
    async (m, r) => {
      emit("chat_message", chatPayload(id), seq);
      await settle();

      if (seq > m.seq) m.seq = seq;
      if (!m.ids.includes(id)) m.ids.push(id);
      checkInvariants(m, r);
    },
  );
}

/**
 * Supersede(next, stale): a newer voice join takes over the session, then a
 * teardown frame for this client's own voice membership lands.
 *  - stale: it names the channel the *older*, already-superseded attempt
 *    owned. It must not tear down the newer session (the server broadcasts a
 *    voice_leave to the leaver on every channel switch, and it can arrive
 *    after the new join has already been granted).
 *  - live: it names the current channel, so this really is our departure —
 *    the session ends and the E2EE state goes with it.
 */
function supersedeCmd(next: number, stale: boolean): Cmd {
  const channel = VOICE_CHANNELS[next] as number;
  const other = VOICE_CHANNELS[1 - next] as number;
  return cmd(
    `Supersede(channel=${channel},${stale ? "stale" : "live"})`,
    (m) => m.connected,
    async (m, r) => {
      emit("voice_state", voiceState(channel, SELF_ID));
      for (const uid of PEER_IDS) emit("voice_state", voiceState(channel, uid));
      await settle();
      // The newer session verifies its peers (livekitE2EE does this from each
      // peer's announce; the crypto is out of scope here).
      for (const uid of PEER_IDS) {
        setPeerVerification({
          userId: uid,
          status: "verified",
          safetyNumber: `sn-${uid}`,
          sessionFingerprint: `fp-${uid}`,
        });
      }
      m.voiceChannel = channel;
      m.verifiedPeers = [...PEER_IDS];
      checkInvariants(m, r, true);

      // …and now the teardown frame arrives.
      emit("voice_leave", { channel_id: stale ? other : channel, user_id: SELF_ID });
      await settle();
      if (stale) {
        exercised.staleTeardown++;
      } else {
        m.voiceChannel = null;
        m.verifiedPeers = [];
      }
      checkInvariants(m, r);
    },
  );
}

/**
 * Resync(dropPeer): a full re-sync — the server rebuilt this client's state
 * from scratch, so its own seq counter may have restarted below our stale
 * watermark and the watermark must reset with it (ws.ts's replay_source
 * "none" branch). `dropPeer` models the peer who left our call during the
 * outage: a full resync never replays that voice_leave, so the ready-time
 * reconciliation is the only thing that can drop their key and verification.
 */
function resyncCmd(dropPeer: boolean): Cmd {
  return cmd(
    `Resync(dropPeer=${dropPeer})`,
    (m) => m.connected,
    async (m, r) => {
      const dropped = dropPeer && m.verifiedPeers.length > 0 ? [m.verifiedPeers[0] as number] : [];
      emit("auth_ok", authOkPayload("none"));
      emit("ready", readyPayload(m, dropped));
      await settle();

      m.seq = 0;
      m.verifiedPeers = m.verifiedPeers.filter((uid) => !dropped.includes(uid));
      checkInvariants(m, r);
    },
  );
}

/** Logout: the intentional teardown — transport and every domain store. */
const logoutCmd = cmd(
  "Logout",
  (m) => m.connected || m.ids.length > 0 || m.voiceChannel !== null,
  async (m, r) => {
    r.client.disconnect();
    clearAuth();
    await settle();

    m.connected = false;
    m.seq = 0;
    m.ids = [];
    m.voiceChannel = null;
    m.verifiedPeers = [];
    expect(r.client.getState()).toBe("disconnected");
    checkInvariants(m, r);
  },
);

const commandArbs = [
  // Listed twice on purpose: every other command needs a live connection, so
  // an under-weighted Connect leaves most generated sequences doing nothing.
  fc.constant(connectCmd),
  fc.constant(connectCmd),
  fc.constant(disconnectCmd),
  fc.constant(registerNowCmd),
  fc
    .tuple(fc.integer(MESSAGE_IDS), fc.integer({ min: 0, max: 8 }))
    .map(([id, seq]) => receiveCmd(id, seq)),
  fc.tuple(fc.integer({ min: 0, max: 1 }), fc.boolean()).map(([n, s]) => supersedeCmd(n, s)),
  fc.boolean().map((drop) => resyncCmd(drop)),
  fc.constant(logoutCmd),
];

/**
 * Fixed by default so CI is reproducible run to run; override to replay a
 * reported counterexample (`OWNCORD_MODEL_SEED=<seed> npm test`). A malformed
 * override throws rather than silently handing fast-check `NaN` (or the `0`
 * an empty variable coerces to) and running a different suite than the one
 * that was asked for.
 */
function modelSeed(): number {
  const raw = process.env.OWNCORD_MODEL_SEED;
  if (raw === undefined) return 20260830;
  // Number("") is 0 and Number("abc") is NaN — both would run a different
  // suite than the one that was asked for, so neither gets a fallback.
  const seed = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(seed)) {
    throw new Error(`OWNCORD_MODEL_SEED must be an integer, got ${JSON.stringify(raw)}`);
  }
  return seed;
}

const SEED = modelSeed();
const NUM_RUNS = 150;
const MAX_COMMANDS = 30;

describe("connection model (fc.commands over the real ws client + dispatcher)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("holds every connection invariant under generated orderings", async () => {
    const live: { real: Real | null } = { real: null };

    await fc.assert(
      fc.asyncProperty(
        fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "large" }),
        async (cmds) => {
          try {
            await fc.asyncModelRun(() => {
              // Fresh transport, dispatcher and stores per run — a run must
              // never inherit the previous one's timers or listeners.
              vi.clearAllTimers();
              mockInvoke.mockReset();
              mockListen.mockClear();
              eventHandlers.clear();
              clearAuth();

              const sent: Real["sent"] = [];
              mockInvoke.mockImplementation(
                async (command: string, args?: { message?: string }) => {
                  if (command === "ws_send" && typeof args?.message === "string") {
                    sent.push(JSON.parse(args.message) as Real["sent"][number]);
                  }
                  return undefined;
                },
              );

              const client = createWsClient();
              const real: Real = { client, cleanup: wireDispatcher(client), sent };
              live.real = real;
              const model: Model = {
                connected: false,
                seq: 0,
                ids: [],
                voiceChannel: null,
                verifiedPeers: [],
              };
              return { model, real };
            }, cmds);
          } finally {
            live.real?.cleanup();
            live.real?.client.disconnect();
            live.real = null;
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("reached every invariant family (a family that stops firing is a hole)", () => {
    for (const [family, count] of Object.entries(exercised)) {
      expect(count, `invariant family "${family}" was never exercised`).toBeGreaterThan(0);
    }
  });
});
