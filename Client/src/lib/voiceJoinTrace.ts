// SRE-M2 (client half): the voice-join timeline.
//
// A failed join used to leave only `{hasRoom:false}` in the voice diagnostics
// bundle — no phase was timed and no failure could be placed. This module owns
// one timeline line per join attempt: which stage it reached (the failure stage
// when it failed), how the URL was resolved, how many connect retries it made,
// and the phase durations. The last few attempts, the receive-side decrypt
// count and the connection self-test's per-stage result are what
// `voice-diagnostics.json` then carries.
//
// A leaf module with no runtime imports, so the join orchestration, the room
// event handlers, the connection diagnostics and the debug-info builder can all
// reach it without a cycle.
import { createLogger } from "./logger";

const log = createLogger("voiceJoinTrace");

/** Stages of a join, in the order an attempt passes through them. The value is
 *  the stage last *reached*; a failure leaves the stage it failed at. */
export type JoinStage = "resolve" | "keyExchange" | "connect" | "activate" | "live";

/** How the LiveKit URL was resolved: a loopback `direct_url` used as-is, the
 *  local Rust TLS tunnel for a remote server, or the proxy path passed through. */
export type JoinUrlKind = "direct" | "tunnel" | "passthrough" | "unknown";

export interface JoinPhaseTimings {
  readonly resolveMs: number | null;
  readonly keyExchangeMs: number | null;
  readonly connectMs: number | null;
  readonly activateMs: number | null;
  /** Join-relative ms at the E2EE key-exchange milestone (the same instant as
   *  keyExchangeMs's completion, kept for the milestone the report names). */
  readonly e2eeMs: number | null;
  /** Join-relative ms at the first local track publication. */
  readonly localTrackMs: number | null;
  /** Join-relative ms at the first remote track subscription. */
  readonly remoteTrackMs: number | null;
}

export interface VoiceJoinAttempt {
  readonly channelId: number;
  readonly startedAt: number;
  readonly urlKind: JoinUrlKind;
  readonly retries: number;
  readonly succeeded: boolean;
  readonly stage: JoinStage;
  readonly timings: JoinPhaseTimings;
}

interface ActiveAttempt {
  id: number;
  channelId: number;
  startedAt: number;
  urlKind: JoinUrlKind;
  retries: number;
  stage: JoinStage;
  /** Wall-clock ms at each phase boundary, for durations. */
  phaseStarts: {
    resolve: number;
    keyExchange: number | null;
    connect: number | null;
    activate: number | null;
  };
  timings: MutableTimings;
}

/** The attempt's live timing cells. Unlike JoinPhaseTimings the marks are
 *  mutable: the SDK can deliver the first track just after connect returns,
 *  once the attempt is already recorded, and that mark still belongs to it. */
interface MutableTimings {
  resolveMs: number | null;
  keyExchangeMs: number | null;
  connectMs: number | null;
  activateMs: number | null;
  e2eeMs: number | null;
  localTrackMs: number | null;
  remoteTrackMs: number | null;
}

interface SelfTest {
  updatedAt: number;
  stages: Record<string, string>;
}

/** Most recent attempts kept for the diagnostics bundle. */
const MAX_LAST_JOINS = 5;

let active: ActiveAttempt | null = null;
/** The most recently recorded attempt, still referenced by the ring, so a
 *  track mark the SDK delivers just after connect returns lands on it. */
let mostRecent: InternalAttempt | null = null;
let nextId = 1;
const lastJoins: InternalAttempt[] = [];
let decryptErrorCount = 0;
let selfTest: SelfTest | null = null;

function emptyTimings(): MutableTimings {
  return {
    resolveMs: null,
    keyExchangeMs: null,
    connectMs: null,
    activateMs: null,
    e2eeMs: null,
    localTrackMs: null,
    remoteTrackMs: null,
  };
}

/** A recorded attempt, kept internally so a late track mark can still mutate
 *  its timings; the snapshot exported publicly hands out a copy. */
interface InternalAttempt {
  channelId: number;
  startedAt: number;
  urlKind: JoinUrlKind;
  retries: number;
  succeeded: boolean;
  stage: JoinStage;
  timings: MutableTimings;
}

function snapshotAttempt(a: ActiveAttempt, succeeded: boolean): InternalAttempt {
  return {
    channelId: a.channelId,
    startedAt: a.startedAt,
    urlKind: a.urlKind,
    retries: a.retries,
    succeeded,
    stage: a.stage,
    timings: { ...a.timings },
  };
}

function pushAttempt(attempt: InternalAttempt): void {
  lastJoins.unshift(attempt);
  if (lastJoins.length > MAX_LAST_JOINS) lastJoins.length = MAX_LAST_JOINS;
  mostRecent = attempt;
}

/** Classify a resolved LiveKit URL for the timeline. A loopback result equal to
 *  the server's `direct_url` is `direct`; the local TLS tunnel and every other
 *  result are told apart by their loopback origin vs the proxy path. */
export function classifyJoinUrl(
  resolved: string,
  directUrl: string | undefined,
  proxyPath: string,
): JoinUrlKind {
  if (directUrl !== undefined && resolved === directUrl) return "direct";
  if (resolved === proxyPath) return "passthrough";
  if (resolved.startsWith("ws://127.0.0.1:") || resolved.startsWith("ws://localhost:"))
    return "tunnel";
  return "unknown";
}

/** Start a new attempt, abandoning any previous one that never finished
 *  (superseded joins are normal churn, not failures, so they are not recorded).
 *  Returns this attempt's id, to pass back to every other mutator. */
export function beginJoinAttempt(channelId: number): number {
  const id = nextId++;
  // A new attempt supersedes any late-mark target from the previous join.
  mostRecent = null;
  active = {
    id,
    channelId,
    startedAt: Date.now(),
    urlKind: "unknown",
    retries: 0,
    stage: "resolve",
    phaseStarts: { resolve: Date.now(), keyExchange: null, connect: null, activate: null },
    timings: emptyTimings(),
  };
  return id;
}

/** Advance the active attempt to the stage it is about to run. */
export function advanceJoinStage(id: number, stage: JoinStage): void {
  const a = active;
  if (a === null || a.id !== id) return;
  const now = Date.now();
  switch (stage) {
    case "keyExchange":
      a.timings.resolveMs = now - a.phaseStarts.resolve;
      a.phaseStarts.keyExchange = now;
      break;
    case "connect":
      if (a.phaseStarts.keyExchange !== null)
        a.timings.keyExchangeMs = now - a.phaseStarts.keyExchange;
      a.timings.e2eeMs = now - a.startedAt;
      a.phaseStarts.connect = now;
      // SRE-M2: the E2EE key-exchange milestone, join-relative.
      log.info("voice join milestone: e2ee key exchange complete", { ms: a.timings.e2eeMs });
      break;
    case "activate":
      if (a.phaseStarts.connect !== null) a.timings.connectMs = now - a.phaseStarts.connect;
      a.phaseStarts.activate = now;
      break;
    case "resolve":
    case "live":
      break;
  }
  a.stage = stage;
}

/** Record how the LiveKit URL was resolved for the active attempt. */
export function setJoinUrlKind(id: number, kind: JoinUrlKind): void {
  const a = active;
  if (a !== null && a.id === id) a.urlKind = kind;
}

/** Count a connect retry the active attempt made. */
export function countJoinRetry(id: number): void {
  const a = active;
  if (a !== null && a.id === id) a.retries++;
}

/** Log a join-relative E2EE key-exchange milestone (announce sent, room key
 *  generated, key holder's offer received, room key applied) for the active
 *  attempt. Outside a join (a mid-call rotation or a reconnect) it is a no-op. */
export function markJoinMilestone(milestone: string): void {
  const a = active;
  if (a === null) return;
  log.info(`voice join milestone: ${milestone}`, { ms: Date.now() - a.startedAt });
}

/** Join-relative ms at the first local track publication. First mark wins.
 *  Falls back to the most recently recorded attempt when the SDK delivers the
 *  publication just after connect returned (the attempt is already recorded). */
export function markLocalTrackPublished(): void {
  const a = active;
  if (a !== null) {
    if (a.timings.localTrackMs === null) {
      a.timings.localTrackMs = Date.now() - a.startedAt;
      log.info("voice join milestone: local track published", { ms: a.timings.localTrackMs });
    }
    return;
  }
  const r = mostRecent;
  if (r !== null && r.succeeded && r.timings.localTrackMs === null) {
    r.timings.localTrackMs = Date.now() - r.startedAt;
    log.info("voice join milestone: local track published", { ms: r.timings.localTrackMs });
  }
}

/** Join-relative ms at the first remote track subscription. First mark wins,
 *  with the same active-then-recent fallback as the local mark. */
export function markFirstRemoteTrackSubscribed(): void {
  const a = active;
  if (a !== null) {
    if (a.timings.remoteTrackMs === null) {
      a.timings.remoteTrackMs = Date.now() - a.startedAt;
      log.info("voice join milestone: first remote track subscribed", {
        ms: a.timings.remoteTrackMs,
      });
    }
    return;
  }
  const r = mostRecent;
  if (r !== null && r.succeeded && r.timings.remoteTrackMs === null) {
    r.timings.remoteTrackMs = Date.now() - r.startedAt;
    log.info("voice join milestone: first remote track subscribed", {
      ms: r.timings.remoteTrackMs,
    });
  }
}

/** Finish the active attempt (by id) successfully and record it. */
export function finishJoinAttempt(id: number): void {
  const a = active;
  if (a === null || a.id !== id) return;
  const now = Date.now();
  if (a.phaseStarts.activate !== null) a.timings.activateMs = now - a.phaseStarts.activate;
  a.stage = "live";
  const attempt = snapshotAttempt(a, true);
  active = null;
  pushAttempt(attempt);
  log.info("voice join timeline", attempt);
}

/** Fail the active attempt (by id) at its current stage and record it. */
export function failJoinAttempt(id: number): void {
  const a = active;
  if (a === null || a.id !== id) return;
  const attempt = snapshotAttempt(a, false);
  active = null;
  pushAttempt(attempt);
  log.warn("voice join timeline", attempt);
}

/** Drop the active attempt (by id) without recording it. Supersession is
 *  normal churn: a newer join replaces this one, so there is no failure to
 *  report and no stale `active` left in the snapshot. */
export function abandonJoinAttempt(id: number): void {
  const a = active;
  if (a !== null && a.id === id) active = null;
}

/** One receive-side E2EE decrypt failure (any error from a remote sender). */
export function recordDecryptError(): void {
  decryptErrorCount++;
}

/** Start a new connection self-test run, discarding the previous run's stages
 *  so a cancelled or aborted run never mixes with an older one. */
export function resetSelfTest(): void {
  selfTest = null;
}

/** The connection self-test's per-stage results for the current run. */
export function recordSelfTestStage(stage: string, status: string): void {
  selfTest ??= { updatedAt: Date.now(), stages: {} };
  selfTest.updatedAt = Date.now();
  selfTest.stages[stage] = status;
}

/** Snapshot for `voice-diagnostics.json` / `getSessionDebugInfo()`. */
export function voiceJoinSnapshot(): {
  active: { channelId: number; stage: JoinStage; urlKind: JoinUrlKind; retries: number } | null;
  lastJoins: VoiceJoinAttempt[];
  decryptErrorCount: number;
  selfTest: SelfTest | null;
} {
  return {
    active:
      active === null
        ? null
        : {
            channelId: active.channelId,
            stage: active.stage,
            urlKind: active.urlKind,
            retries: active.retries,
          },
    lastJoins: lastJoins.map((attempt) => ({ ...attempt, timings: { ...attempt.timings } })),
    decryptErrorCount,
    selfTest: selfTest === null ? null : { ...selfTest, stages: { ...selfTest.stages } },
  };
}
