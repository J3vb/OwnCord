/**
 * The page half of Windows per-app share audio: read the host's
 * loopback WebSocket of 10 ms stereo frames, play them through the app-audio
 * worklet's jitter buffer and hand back the resulting `MediaStreamTrack`.
 *
 * One message is 480 stereo frames of interleaved little-endian float32 =
 * 3,840 bytes (`src-tauri/src/windows_app_audio.rs`, `FRAME_BYTES`); anything
 * else is ignored. The worklet is a plain script in `public/` loaded by URL
 * (the CSP forbids blob and inline modules), like `vad-worklet.js`.
 */

import { createLogger } from "./logger";
import { publicAssetUrl } from "./publicAssets";

const log = createLogger("appAudioTrack");

/** One host frame: 480 stereo f32 samples. */
export const APP_AUDIO_FRAME_BYTES = 3840;
export const APP_AUDIO_SAMPLE_RATE = 48000;
export const APP_AUDIO_WORKLET_URL = publicAssetUrl("app-audio-worklet.js");
export const APP_AUDIO_PROCESSOR = "app-audio-processor";
/** The socket is on this machine: it opens at once or not at all. */
const OPEN_TIMEOUT_MS = 3000;
const RESUME_WAIT_MS = 500;

export interface AppAudioHandle {
  /** The app's sound, as a stereo audio track. */
  readonly track: MediaStreamTrack;
  /** Close the socket, the audio graph and the track. Safe to call twice. */
  close(): void;
}

/** Resolves once the socket is open; rejects if it closes or fails first. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      // i18n-exempt: internal diagnostic; callers show the catalog toast, not this message
      () => settle(new Error("app audio socket timed out")),
      OPEN_TIMEOUT_MS,
    );
    const settle = (err?: Error): void => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onFail);
      ws.removeEventListener("close", onFail);
      if (err === undefined) resolve();
      else reject(err);
    };
    const onOpen = (): void => settle();
    // i18n-exempt: internal diagnostic; callers show the catalog toast, not this message
    const onFail = (): void => settle(new Error("app audio socket failed"));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onFail);
    ws.addEventListener("close", onFail);
  });
}

function NO_LISTENER(): void {}

/** A message listener that hands each whole host frame to the worklet. */
function frameForwarder(port: MessagePort): (event: MessageEvent) => void {
  return (event) => {
    const data: unknown = event.data;
    if (!(data instanceof ArrayBuffer) || data.byteLength !== APP_AUDIO_FRAME_BYTES) return;
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
    port.postMessage(new Float32Array(data), [data]);
  };
}

/** Ask `ctx` to start, but wait at most RESUME_WAIT_MS for it. */
async function resumeBriefly(ctx: AudioContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RESUME_WAIT_MS);
  });
  try {
    await Promise.race([
      ctx.resume().catch((err: unknown) => log.debug("AudioContext resume failed", err)),
      waited,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Connect to the host's app-audio socket and turn it into a track. Rejects
 *  (after releasing everything it opened) if the worklet cannot load or the
 *  socket does not open. */
export async function openAppAudio(url: string): Promise<AppAudioHandle> {
  const ctx = new AudioContext({ sampleRate: APP_AUDIO_SAMPLE_RATE });
  let ws: WebSocket | null = null;
  let node: AudioWorkletNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let closed = false;
  let onMessage: (event: MessageEvent) => void = NO_LISTENER;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (ws !== null) {
      ws.removeEventListener("message", onMessage);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    try {
      node?.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const t of destination?.stream.getTracks() ?? []) t.stop();
    void ctx.close().catch((err: unknown) => log.debug("AudioContext close failed", err));
  };

  try {
    await ctx.audioWorklet.addModule(APP_AUDIO_WORKLET_URL);
    node = new AudioWorkletNode(ctx, APP_AUDIO_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    destination = ctx.createMediaStreamDestination();
    destination.channelCount = 2;
    node.connect(destination);
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    onMessage = frameForwarder(node.port);
    ws.addEventListener("message", onMessage);
    await opened(ws);
    const socket = ws;
    socket.addEventListener("close", () => {
      if (!closed) log.debug("App audio socket closed by the host");
    });
    // A context made outside a user gesture can start suspended.
    // resume() can stay pending when the context may not start yet: wait a
    // moment, then go on either way (it starts once allowed).
    await resumeBriefly(ctx);
    const track = destination.stream.getAudioTracks()[0];
    // i18n-exempt: internal diagnostic; callers show the catalog toast, not this message
    if (track === undefined) throw new Error("app audio destination has no track");
    // i18n-exempt: internal diagnostic; callers show the catalog toast, not this message
    if (closed) throw new Error("app audio closed while opening");
    return { track, close };
  } catch (err) {
    close();
    throw err;
  }
}
