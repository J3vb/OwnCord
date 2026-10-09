// Scout test (owncord-robot-voice-after-reconnect): the two ways the call's
// microphone is captured must ask the browser for the same processing.
//
// A join, a rejoin after a server restart, and an unmute with
// stopMicTrackOnMute all capture through livekit-client's createLocalTracks,
// which merges its own `audioDefaults` into the request (livekit-client
// 2.22.3 dist: `voiceIsolation: true` among them). A processing toggle in
// Settings re-captures through LocalAudioTrack.restartTrack(micCaptureOptions()),
// which sends the saved flags and nothing else. The settings tab shows, and
// its meter measures, micCaptureOptions(); the call must capture with the same
// request, or leaving and rejoining changes the voice while every visible
// setting stays the same.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalTracks, LocalAudioTrack } from "livekit-client";
import { micCaptureOptions, micProcessingOptions } from "../../src/lib/audioPipeline";
import { savePref } from "../../src/lib/preferences";
import {
  FakeMediaStream,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/** Every getUserMedia request the SDK made, in order. */
let requests: MediaStreamConstraints[] = [];

function stubCapture(): void {
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        requests.push(structuredClone(constraints));
        return new FakeMediaStream([fakeMediaStreamTrack(`mic-${requests.length}`)]);
      }),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

/** The join path: what RoomLifecycle.createRoom puts in audioCaptureDefaults,
 *  handed on unchanged by LocalParticipant.createTracks to createLocalTracks. */
async function joinPathRequest(): Promise<MediaTrackConstraints> {
  const tracks = await createLocalTracks({ audio: micProcessingOptions() });
  for (const t of tracks) t.stop();
  return requests[0]!.audio as MediaTrackConstraints;
}

/** The settings-toggle path: AudioPipeline.reapplyAudioProcessing. */
async function togglePathRequest(): Promise<MediaTrackConstraints> {
  const track = new LocalAudioTrack(fakeMediaStreamTrack("mic-0"), undefined, false);
  await track.restartTrack(micCaptureOptions());
  track.stop();
  return requests[0]!.audio as MediaTrackConstraints;
}

describe("microphone capture request: join path vs settings toggle", () => {
  beforeEach(() => {
    requests = [];
    installFakeAudio();
    stubCapture();
    // The friend's saved settings (support bundle 2026-10-08): AGC off.
    savePref("echoCancellation", true);
    savePref("noiseSuppression", true);
    savePref("autoGainControl", false);
    savePref("audioInputDevice", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("the toggle path sends the saved flags and nothing else", async () => {
    const audio = await togglePathRequest();
    expect(audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
    const shown = new Set([...Object.keys(micCaptureOptions()), "deviceId"]);
    expect(Object.keys(audio).filter((k) => !shown.has(k))).toEqual([]);
  });

  it("the join path sends the same processing request as the toggle path", async () => {
    const audio = await joinPathRequest();
    // The saved flags arrive intact...
    expect(audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
    // ...and nothing the settings tab does not show or the meter does not
    // measure rides along. deviceId is the SDK's `ideal: default` and is fine.
    const shown = new Set([...Object.keys(micCaptureOptions()), "deviceId"]);
    const extra = Object.keys(audio).filter((k) => !shown.has(k));
    expect(extra, `join-only constraints ${JSON.stringify(extra)}`).toEqual([]);
  });
});
