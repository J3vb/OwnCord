// The host side of `mobileAudio`, loaded in the Android app only
// (`src-tauri/src/mobile_audio.rs`, `MobileAudioPlugin.kt`). The plugin sends
// its audio state as `state` events and as the answer to each command, every
// one numbered, so whichever arrives late is dropped. Commands go out one at a
// time: the host runs each as a task of its own, and two on their way at once
// could reach the plugin either way round.
import { addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import { tryInvoke, type NativeResult } from "./nativeInvoke";
import type { AudioRoute, AudioRouteKind, MobileAudioState } from "../contracts/mobileAudio";

const log = createLogger("mobileAudio");
const KINDS: ReadonlySet<string> = new Set(["speaker", "earpiece", "wired", "bluetooth"]);

/** Bumped by each `watch`, so an older watcher's late answers go nowhere. */
let generation = 0;
/** The number of the newest state handed on. */
let lastSeq = 0;
let deliver: ((state: MobileAudioState) => void) | null = null;
/** Settles when the last command made was answered; the next goes out then. */
let answered: Promise<unknown> = Promise.resolve();

function isKind(value: unknown): value is AudioRouteKind {
  return typeof value === "string" && KINDS.has(value);
}

function readRoute(raw: unknown): AudioRoute | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, name } = raw as Record<string, unknown>;
  return isKind(kind) ? { kind, name: typeof name === "string" ? name : "" } : null;
}

/** The plugin's state and its number, or null for anything else. */
function readState(raw: unknown): { seq: number; state: MobileAudioState } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { seq, supported, routes, active, manual, interrupted, lost } = raw as Record<
    string,
    unknown
  >;
  if (typeof seq !== "number" || typeof supported !== "boolean") return null;
  if (!Array.isArray(routes) || !isKind(active)) return null;
  return {
    seq,
    state: {
      supported,
      routes: routes.flatMap((route) => readRoute(route) ?? []),
      active,
      manual: isKind(manual) ? manual : null,
      interrupted: interrupted === true,
      lost: typeof lost === "number" ? lost : 0,
    },
  };
}

/** Hand a state on, unless its watcher is gone or a newer one already went. */
function accept(raw: unknown, mine: number): void {
  if (mine !== generation || deliver === null) return;
  const next = readState(raw);
  if (next === null || next.seq <= lastSeq) return;
  lastSeq = next.seq;
  deliver(next.state);
}

/** Make a plugin command once the ones made before it were answered, and take
 *  its answer: the state the command left. `tryInvoke` never rejects, so one
 *  refused command does not hold up the next. */
function send(command: () => Promise<NativeResult<unknown>>): void {
  const mine = generation;
  const answer = answered.then(command);
  answered = answer;
  void answer.then((result) => {
    if (result.ok) accept(result.value, mine);
    else log.warn(`${result.error.command} failed`, result.error.message);
  });
}

function stop(listener: PluginListener): void {
  void listener.unregister().catch((err: unknown) => log.debug("Unlisten failed", err));
}

export function watch(signal: AbortSignal, onState: (state: MobileAudioState) => void): void {
  const mine = ++generation;
  lastSeq = 0;
  deliver = null;
  if (signal.aborted) return;
  void addPluginListener<unknown>("owncord-mobile-audio", "state", (payload) =>
    accept(payload, mine),
  ).then(
    (listener) => {
      if (signal.aborted || mine !== generation) {
        stop(listener);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          stop(listener);
          if (mine === generation) deliver = null;
        },
        { once: true },
      );
      // States are handed on only from here: with the listener in, the state
      // asked for now and every change after it arrive, none in between lost.
      deliver = onState;
      send(() => tryInvoke<unknown>("mobile_audio_state"));
    },
    // Without its events a state would go stale: report nothing at all.
    (err: unknown) => log.warn("Call audio events unavailable; no route control", err),
  );
}

export function setSession(active: boolean): void {
  send(() => tryInvoke<unknown>("mobile_audio_set_session", { active }));
}

export function setRoute(kind: AudioRouteKind | null): void {
  send(() => tryInvoke<unknown>("mobile_audio_set_route", { kind: kind ?? "" }));
}

export function refresh(): void {
  send(() => tryInvoke<unknown>("mobile_audio_state"));
}
