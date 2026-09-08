/** User-initiated checks of the current client's path; never starts a call. */
import type { Room } from "livekit-client";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import { loadPref } from "@components/settings/helpers";

export type DiagnosticStatus = "running" | "passed" | "failed" | "not-tested";
export type DiagnosticStage =
  "connection" | "authentication" | "websocket" | "microphone" | "signaling" | "media";
export interface DiagnosticResult {
  readonly stage: DiagnosticStage;
  readonly status: DiagnosticStatus;
  readonly detail: string;
}
export const DIAGNOSTIC_LABELS: Record<DiagnosticStage, string> = {
  connection: "Server connection",
  authentication: "Signed-in access",
  websocket: "Live message connection",
  microphone: "Microphone access",
  signaling: "Voice signaling",
  media: "Incoming media",
};

export interface DiagnosticServices {
  api: Pick<ApiClient, "getSession" | "getConfig" | "getHealth" | "getMe">;
  ws: Pick<WsClient, "ping">;
  getRoom(): Room | null | Promise<Room | null>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

let configured: DiagnosticServices | null = null;

export function getConnectionDiagnosticsSessionSignal(): AbortSignal | undefined {
  return configured?.api.getSession().signal;
}

export function configureConnectionDiagnostics(api: ApiClient, ws: WsClient): void {
  configured = {
    api,
    ws,
    getRoom: async () => (await import("@lib/livekitSession")).getRoomForStats(),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
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
  const report = await room.engine.pcManager?.subscriber?.getStats();
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

function connectionFailure(error: unknown): string {
  // Do not expose raw proxy errors (URLs, certificate fingerprints or tokens).
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The server did not respond in time. Check your connection and server address, then retry.";
  }
  return "The server could not be reached through the normal certificate-checked connection. Check the server address and any certificate prompt, then retry.";
}

/** Each result belongs to one session. Abort rejects without emitting stale
 * results; the caller can report cancellation without preserving green checks. */
export async function runConnectionDiagnostics(
  onResult: (result: DiagnosticResult) => void,
  signal: AbortSignal,
  includeMicrophone: boolean,
  services: DiagnosticServices | null = configured,
): Promise<void> {
  if (!services) throw new Error("Diagnostics are not available yet.");
  const { api, ws } = services;
  const owner = api.getSession();
  const lifetime = AbortSignal.any([signal, owner.signal]);
  const emit = (stage: DiagnosticStage, status: DiagnosticStatus, detail: string): void => {
    lifetime.throwIfAborted();
    owner.assertCurrent();
    onResult({ stage, status, detail });
  };
  const check = async (
    stage: DiagnosticStage,
    task: () => Promise<string>,
    failure: (error: unknown) => string,
  ): Promise<void> => {
    emit(stage, "running", "Checking…");
    try {
      const detail = await bounded(task(), lifetime, stage === "microphone" ? 12_000 : 8_000);
      emit(stage, "passed", detail);
    } catch (error) {
      lifetime.throwIfAborted();
      emit(stage, "failed", failure(error));
    }
  };

  if (api.getConfig().host) {
    await check(
      "connection",
      async () => {
        await api.getHealth(undefined, 5000, lifetime);
        return "This client reached the server through its normal certificate-checked connection.";
      },
      connectionFailure,
    );
  } else {
    emit("connection", "not-tested", "Choose and connect to a server, then run this test again.");
  }

  if (api.getConfig().token) {
    await check(
      "authentication",
      async () => {
        await api.getMe(lifetime);
        return "The server accepted a fresh request for your signed-in account.";
      },
      () => "The account request failed. Reconnect or sign in again, then retry.",
    );
    await check(
      "websocket",
      async () => {
        await ws.ping(lifetime);
        return "A fresh heartbeat response arrived on your authenticated message connection.";
      },
      () =>
        "No live heartbeat response arrived. Wait for reconnection or check whether your network allows WebSocket connections.",
    );
  } else {
    emit("authentication", "not-tested", "Sign in to test access to your account.");
    emit("websocket", "not-tested", "Sign in to test the live message connection.");
  }

  if (includeMicrophone) {
    await check(
      "microphone",
      async () => {
        const selected = loadPref<string>("audioInputDevice", "");
        // getUserMedia cannot cancel a permission prompt. Always stop the tracks
        // in its fulfillment handler, even after timeout, close or server switch.
        const stream = await services.getUserMedia({
          audio: selected ? { deviceId: { exact: selected } } : true,
          video: false,
        });
        try {
          if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
            throw new Error("No live audio track.");
          }
          return "Your selected microphone opened successfully. The test capture has stopped; no audio was sent.";
        } finally {
          for (const track of stream.getTracks()) track.stop();
        }
      },
      (error) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          return "Microphone access was denied. Allow it in your app or system privacy settings, then retry.";
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          return "The microphone prompt did not finish. Dismiss any pending prompt, then retry. Any late capture will be stopped.";
        }
        return "The selected microphone could not open. Check Voice & Audio settings and reconnect your device.";
      },
    );
  } else {
    emit("microphone", "not-tested", "Microphone check was not selected.");
  }

  lifetime.throwIfAborted();
  const room = await bounded(Promise.resolve(services.getRoom()), lifetime, 5000);
  if (!room) {
    emit("signaling", "not-tested", "Join a voice channel yourself, then run this test again.");
    emit(
      "media",
      "not-tested",
      "Join a call with another person speaking or sharing video to test incoming media.",
    );
    return;
  }
  if (room.state !== "connected" || room.engine.client.ws?.readyState !== WebSocket.OPEN) {
    emit(
      "signaling",
      "failed",
      "The current voice signaling connection is not open. Wait for voice recovery or leave and rejoin the channel.",
    );
    emit("media", "not-tested", "Restore the voice connection before checking incoming media.");
    return;
  }
  emit("signaling", "passed", "Your current call has an open voice signaling connection.");
  if (room.remoteParticipants.size === 0) {
    emit(
      "media",
      "not-tested",
      "No other participant is in this call. Ask someone to join and speak or share video, then retry.",
    );
    return;
  }
  emit(
    "media",
    "running",
    "Listening for decoded incoming media for three seconds. Ask another participant to speak or share video.",
  );
  try {
    const before = await bounded(readDecoding(room), lifetime, 5000);
    await pause(lifetime, 3000);
    const after = await bounded(readDecoding(room), lifetime, 5000);
    if (
      (await bounded(Promise.resolve(services.getRoom()), lifetime, 5000)) !== room ||
      room.state !== "connected"
    ) {
      emit(
        "media",
        "failed",
        "The call changed during the check. Run it again in your current call.",
      );
      return;
    }
    let audio = false;
    let video = false;
    if (before && after) {
      for (const [id, value] of after) {
        const previous = before.get(id);
        if (!previous) continue;
        audio ||= value.energy > previous.energy && value.samples > previous.samples;
        video ||= value.frames > previous.frames;
      }
    }
    if (audio || video) {
      const kinds = [audio ? "audio" : "", video ? "video" : ""].filter(Boolean).join(" and ");
      emit(
        "media",
        "passed",
        `Incoming ${kinds} decoded during this check. This does not test your speakers, outgoing media, or the other person's identity.`,
      );
    } else {
      emit(
        "media",
        "not-tested",
        "No advancing decoded media was observed. Ask someone to speak or share video and retry. If they are already sending, check voice permissions, encryption warnings and the media network path.",
      );
    }
  } catch {
    lifetime.throwIfAborted();
    emit("media", "failed", "Incoming media could not be inspected. Rejoin the call and retry.");
  }
}
