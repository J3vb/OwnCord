/** User-initiated checks of the current client's path; never starts a call. */
import type { Room } from "livekit-client";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import { loadPref } from "@lib/prefs/preferences";
import { isMissingDeviceError } from "@lib/voice/audioPipeline";
import { nativeAudioDevices, type AudioDevice } from "../../features/voice/native/devices";
import { probeNativeMicrophone, type NativeMicProbe } from "../../features/voice/native/micProbe";
import { isLinuxDesktop } from "../../features/voice/native/platform";
import { settingsText as t } from "../../i18n/settings";

export type DiagnosticStatus = "running" | "passed" | "failed" | "not-tested";
export type DiagnosticStage =
  "connection" | "authentication" | "websocket" | "microphone" | "signaling" | "media";
export interface DiagnosticResult {
  readonly stage: DiagnosticStage;
  readonly status: DiagnosticStatus;
  readonly detail: string;
}
const DIAGNOSTIC_LABEL_KEYS = {
  connection: "diagnostics.stage.connection",
  authentication: "diagnostics.stage.authentication",
  websocket: "diagnostics.stage.websocket",
  microphone: "diagnostics.stage.microphone",
  signaling: "diagnostics.stage.signaling",
  media: "diagnostics.stage.media",
} as const satisfies Record<DiagnosticStage, string>;

/** Resolve a stage's display label where it renders. */
export function diagnosticLabel(stage: DiagnosticStage): string {
  return t(DIAGNOSTIC_LABEL_KEYS[stage]);
}

export interface DiagnosticServices {
  api: Pick<ApiClient, "getSession" | "getConfig" | "getHealth" | "getMe">;
  ws: Pick<WsClient, "ping">;
  getRoom(): Room | null | Promise<Room | null>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** The native backend's microphones on Linux, where the webview cannot
   *  open the devices voice uses; null elsewhere. */
  listNativeInputs(): Promise<AudioDevice[] | null>;
  /** Opens the native capture for about a second (Linux) and stops it;
   *  aborting `signal` stops it too. */
  probeNativeInput(input: string, signal: AbortSignal): Promise<NativeMicProbe>;
}

/** NativeRoom has no browser signaling socket; it reports its own. */
interface NativeSignaling {
  isSignalingConnected(): boolean;
}

function nativeSignaling(room: Room): NativeSignaling | null {
  const probe: unknown = Reflect.get(room, "isSignalingConnected");
  return typeof probe === "function"
    ? { isSignalingConnected: () => probe.call(room) === true }
    : null;
}

let configured: DiagnosticServices | null = null;

export function getConnectionDiagnosticsSessionSignal(): AbortSignal | undefined {
  return configured?.api.getSession().signal;
}

export function configureConnectionDiagnostics(api: ApiClient, ws: WsClient): void {
  configured = {
    api,
    ws,
    getRoom: async () => (await import("@lib/voice/livekitSession")).getRoomForStats(),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    listNativeInputs: () => nativeAudioDevices("audioinput"),
    probeNativeInput: probeNativeMicrophone,
  };
}

/** Races operations that cannot themselves abort (native proxy setup, device
 * permission prompts, RTC stats). Late fulfillment is still consumed. */
function bounded<T>(task: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      // i18n-exempt: internal TimeoutError name/type, its detail is a catalog line
      reject(new DOMException("The check timed out.", "TimeoutError"));
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

interface DecodingSnapshot {
  energy: number;
  samples: number;
  frames: number;
}

async function readDecoding(room: Room): Promise<Map<string, DecodingSnapshot> | null> {
  const manager = room.engine.pcManager;
  // LiveKit receives media on the publisher in single-peer-connection mode.
  // Dual-connection sessions keep their incoming tracks on the subscriber.
  const receiver = manager?.subscriber ?? manager?.publisher;
  const report = await receiver?.getStats();
  if (!report) return null;
  const result = new Map<string, DecodingSnapshot>();
  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type !== "inbound-rtp" || typeof entry.id !== "string") return;
    result.set(entry.id, {
      energy: typeof entry.totalAudioEnergy === "number" ? entry.totalAudioEnergy : 0,
      // Concealed samples can advance when encrypted packets cannot decode.
      samples:
        typeof entry.totalSamplesReceived === "number" && typeof entry.concealedSamples === "number"
          ? Math.max(0, entry.totalSamplesReceived - entry.concealedSamples)
          : 0,
      frames: typeof entry.framesDecoded === "number" ? entry.framesDecoded : 0,
    });
  });
  return result;
}

/** The native microphone opened but reported no audio. */
class SilentMicrophone extends Error {}

function connectionFailure(error: unknown): string {
  // Do not expose raw proxy errors (URLs, certificate fingerprints or tokens).
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return t("diagnostics.detail.connectionTimeout");
  }
  return t("diagnostics.detail.connectionRefused");
}

type CheckOutcome = string | { status: "not-tested"; detail: string };

/** One diagnostics run: the services, the combined abort signal and the two
 * emitters every stage shares. */
interface DiagnosticRun {
  readonly services: DiagnosticServices;
  readonly lifetime: AbortSignal;
  emit(stage: DiagnosticStage, status: DiagnosticStatus, detail: string): void;
  check(
    stage: DiagnosticStage,
    task: () => Promise<CheckOutcome>,
    failure: (error: unknown) => string,
  ): Promise<void>;
}

function createRun(
  onResult: (result: DiagnosticResult) => void,
  signal: AbortSignal,
  services: DiagnosticServices,
): DiagnosticRun {
  const owner = services.api.getSession();
  const lifetime = AbortSignal.any([signal, owner.signal]);
  const emit = (stage: DiagnosticStage, status: DiagnosticStatus, detail: string): void => {
    lifetime.throwIfAborted();
    owner.assertCurrent();
    onResult({ stage, status, detail });
  };
  const check: DiagnosticRun["check"] = async (stage, task, failure) => {
    emit(stage, "running", t("diagnostics.detail.checking"));
    try {
      const outcome = await bounded(task(), lifetime, stage === "microphone" ? 12_000 : 8_000);
      if (typeof outcome === "string") emit(stage, "passed", outcome);
      else emit(stage, outcome.status, outcome.detail);
    } catch (error) {
      lifetime.throwIfAborted();
      emit(stage, "failed", failure(error));
    }
  };
  return { services, lifetime, emit, check };
}

async function checkConnection(run: DiagnosticRun): Promise<void> {
  const { api } = run.services;
  if (!api.getConfig().host) {
    run.emit("connection", "not-tested", t("diagnostics.detail.noServer"));
    return;
  }
  await run.check(
    "connection",
    async () => {
      await api.getHealth(undefined, 5000, run.lifetime);
      return t("diagnostics.detail.connectionPassed");
    },
    connectionFailure,
  );
}

async function checkAccount(run: DiagnosticRun): Promise<void> {
  const { api, ws } = run.services;
  if (!api.getConfig().token) {
    run.emit("authentication", "not-tested", t("diagnostics.detail.signInAccount"));
    run.emit("websocket", "not-tested", t("diagnostics.detail.signInMessage"));
    return;
  }
  await run.check(
    "authentication",
    async () => {
      await api.getMe(run.lifetime);
      return t("diagnostics.detail.authPassed");
    },
    () => t("diagnostics.detail.authFailed"),
  );
  await run.check(
    "websocket",
    async () => {
      await ws.ping(run.lifetime);
      return t("diagnostics.detail.wsPassed");
    },
    () => t("diagnostics.detail.wsFailed"),
  );
}

/** Linux voice opens the device in the native backend, so the check opens it
 * there for a second and passes only when levels arrive. */
async function nativeMicrophoneOutcome(
  run: DiagnosticRun,
  selected: string,
  nativeInputs: AudioDevice[],
): Promise<CheckOutcome> {
  // i18n-exempt: internal guard mapped to the microphone failure catalog line
  if (nativeInputs.length === 0) throw new Error("No native microphone.");
  const present = selected === "" || nativeInputs.some((d) => d.deviceId === selected);
  const probe = await run.services.probeNativeInput(present ? selected : "", run.lifetime);
  if (probe === "in-call") {
    return { status: "not-tested", detail: t("diagnostics.detail.micNativeInCall") };
  }
  if (probe === "silent") throw new SilentMicrophone();
  return present
    ? t("diagnostics.detail.micNativePresent")
    : t("diagnostics.detail.micNativeDefault");
}

async function webMicrophoneOutcome(
  services: DiagnosticServices,
  selected: string,
): Promise<CheckOutcome> {
  // getUserMedia cannot cancel a permission prompt. Always stop the tracks
  // in its fulfillment handler, even after timeout, close or server switch.
  const audio = selected ? { deviceId: { exact: selected } } : {};
  const stream = await services.getUserMedia({ audio, video: false }).catch((err: unknown) => {
    if (!isMissingDeviceError(err, audio)) throw err;
    return services.getUserMedia({ audio: { deviceId: "default" }, video: false });
  });
  try {
    if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
      // i18n-exempt: internal guard mapped to the microphone failure catalog line
      throw new Error("No live audio track.");
    }
    return t("diagnostics.detail.micPassed");
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

function microphoneFailure(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") return t("diagnostics.detail.micDenied");
  if (name === "TimeoutError") return t("diagnostics.detail.micTimeout");
  if (error instanceof SilentMicrophone) return t("diagnostics.detail.micSilent");
  return t("diagnostics.detail.micFailed");
}

async function checkMicrophone(run: DiagnosticRun, includeMicrophone: boolean): Promise<void> {
  if (!includeMicrophone) {
    run.emit("microphone", "not-tested", t("diagnostics.detail.micSkipped"));
    return;
  }
  await run.check(
    "microphone",
    async () => {
      const selected = loadPref<string>("audioInputDevice", "");
      const nativeInputs = await run.services.listNativeInputs();
      if (nativeInputs !== null) return nativeMicrophoneOutcome(run, selected, nativeInputs);
      return webMicrophoneOutcome(run.services, selected);
    },
    microphoneFailure,
  );
}

function isSignalingOpen(room: Room, native: NativeSignaling | null): boolean {
  const socketOpen = native
    ? native.isSignalingConnected()
    : room.engine.client.ws?.readyState === WebSocket.OPEN;
  return room.state === "connected" && socketOpen;
}

interface MediaEvidence {
  audio: boolean;
  video: boolean;
}

function mediaEvidence(
  before: Map<string, DecodingSnapshot> | null,
  after: Map<string, DecodingSnapshot> | null,
): MediaEvidence {
  const evidence = { audio: false, video: false };
  if (!before || !after) return evidence;
  for (const [id, value] of after) {
    const previous = before.get(id);
    if (!previous) continue;
    evidence.audio ||= value.energy > previous.energy && value.samples > previous.samples;
    evidence.video ||= value.frames > previous.frames;
  }
  return evidence;
}

function mediaKindsKey({
  audio,
  video,
}: MediaEvidence):
  | "diagnostics.detail.kinds.audioAndVideo"
  | "diagnostics.detail.kinds.audio"
  | "diagnostics.detail.kinds.video" {
  if (audio && video) return "diagnostics.detail.kinds.audioAndVideo";
  return audio ? "diagnostics.detail.kinds.audio" : "diagnostics.detail.kinds.video";
}

async function checkMedia(run: DiagnosticRun, room: Room): Promise<void> {
  const { services, lifetime, emit } = run;
  emit("media", "running", t("diagnostics.detail.listening"));
  try {
    const before = await bounded(readDecoding(room), lifetime, 5000);
    await pause(lifetime, 3000);
    const after = await bounded(readDecoding(room), lifetime, 5000);
    if (
      (await bounded(Promise.resolve(services.getRoom()), lifetime, 5000)) !== room ||
      room.state !== "connected"
    ) {
      emit("media", "failed", t("diagnostics.detail.callChanged"));
      return;
    }
    const evidence = mediaEvidence(before, after);
    if (evidence.audio || evidence.video) {
      const kinds = t(mediaKindsKey(evidence));
      emit("media", "passed", t("diagnostics.detail.mediaPassed", { kinds }));
    } else {
      emit("media", "not-tested", t("diagnostics.detail.mediaMissing"));
    }
  } catch {
    lifetime.throwIfAborted();
    emit("media", "failed", t("diagnostics.detail.mediaFailed"));
  }
}

async function checkVoice(run: DiagnosticRun): Promise<void> {
  const { services, lifetime, emit } = run;
  lifetime.throwIfAborted();
  const room = await bounded(Promise.resolve(services.getRoom()), lifetime, 5000);
  if (!room) {
    emit("signaling", "not-tested", t("diagnostics.detail.joinVoice"));
    emit(
      "media",
      "not-tested",
      t(isLinuxDesktop() ? "diagnostics.detail.mediaNative" : "diagnostics.detail.joinCall"),
    );
    return;
  }
  const native = nativeSignaling(room);
  if (!isSignalingOpen(room, native)) {
    emit("signaling", "failed", t("diagnostics.detail.signalingClosed"));
    emit("media", "not-tested", t("diagnostics.detail.restoreVoice"));
    return;
  }
  emit("signaling", "passed", t("diagnostics.detail.signalingOpen"));
  if (native) {
    emit("media", "not-tested", t("diagnostics.detail.mediaNative"));
    return;
  }
  if (room.remoteParticipants.size === 0) {
    emit("media", "not-tested", t("diagnostics.detail.noParticipant"));
    return;
  }
  await checkMedia(run, room);
}

/** Each result belongs to one session. Abort rejects without emitting stale
 * results; the caller can report cancellation without preserving green checks. */
export async function runConnectionDiagnostics(
  onResult: (result: DiagnosticResult) => void,
  signal: AbortSignal,
  includeMicrophone: boolean,
  services: DiagnosticServices | null = configured,
): Promise<void> {
  // i18n-exempt: internal configuration guard, never rendered
  if (!services) throw new Error("Diagnostics are not available yet.");
  const run = createRun(onResult, signal, services);
  await checkConnection(run);
  await checkAccount(run);
  await checkMicrophone(run, includeMicrophone);
  await checkVoice(run);
}
