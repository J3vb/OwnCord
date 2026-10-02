// The one boundary every sender swap goes through is livekit-client's own
// choice of track: `LocalTrack.mediaStreamTrack` is the processor's output
// while a processor is attached, and its restart keeps the processor. This
// drives the real LocalAudioTrack (jsdom, fake capture and sender) through
// each path that used to put the raw capture track on the sender, and checks
// that the sender only ever received the processor's gated output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAudioTrack, Track } from "livekit-client";
import { createMicProcessor, type MicProcessor } from "../../src/lib/micProcessor";
import { AudioPipeline } from "../../src/lib/audioPipeline";
import {
  FakeAudioContext,
  FakeMediaStream,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let captures = 0;
function stubCapture(): void {
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(
        async () => new FakeMediaStream([fakeMediaStreamTrack(`mic-${++captures}`)]),
      ),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

function fakeSender() {
  return {
    track: null as MediaStreamTrack | null,
    transport: { state: "connected" },
    replaceTrack: vi.fn(async function (this: { track: MediaStreamTrack | null }, t) {
      this.track = t;
    }),
  };
}

/** The processor's own context (the track's constructor opens another one
 *  for livekit-client's silence check). */
const contextOf = (track: LocalAudioTrack): FakeAudioContext =>
  (track.getProcessor() as unknown as MicProcessor).context as unknown as FakeAudioContext;

/** A microphone LocalAudioTrack as setMicrophoneEnabled would have created it. */
function micTrack(): LocalAudioTrack {
  const track = new LocalAudioTrack(fakeMediaStreamTrack(`mic-${++captures}`), undefined, false);
  track.source = Track.Source.Microphone;
  // Room.publishDefaults.stopMicTrackOnMute: a mute stops the capture and an
  // unmute reacquires the device — the restart path a push-to-talk press used
  // to take on every key-down.
  track.stopOnMute = true;
  return track;
}

describe("mic processor on livekit-client's LocalAudioTrack", () => {
  beforeEach(() => {
    captures = 0;
    installFakeAudio();
    stubCapture();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes the processor's output, and keeps it on the sender through every SDK restart path", async () => {
    const track = micTrack();
    const pipeline = new AudioPipeline();
    await pipeline.attach(track);
    const ctx = contextOf(track);
    const processed = ctx.outputTrack;
    expect(track.getProcessor()?.processedTrack).toBe(processed);

    // What publishTrack / a full-reconnect republish hands the new sender.
    expect(track.mediaStreamTrack).toBe(processed);

    const sender = fakeSender();
    track.sender = sender as unknown as RTCRtpSender;
    const rawTracks = () =>
      sender.replaceTrack.mock.calls.map(([t]) => t).filter((t) => t !== processed);

    // A processing toggle (echo cancellation / noise suppression / AGC).
    await track.restartTrack({ echoCancellation: false });
    expect(track.mediaStreamTrack).toBe(processed);
    expect(rawTracks()).toEqual([]);

    // An input device switch, and the device-ended restart (same restart).
    await track.setDeviceId({ exact: "usb-mic" });
    expect(track.mediaStreamTrack).toBe(processed);
    expect(rawTracks()).toEqual([]);

    // A user mute and unmute: the capture stops and is reacquired.
    await track.mute();
    await track.unmute();
    expect(track.mediaStreamTrack).toBe(processed);
    expect(rawTracks()).toEqual([]);

    // The SDK restarted the capture each time and the processor followed it.
    expect(captures).toBeGreaterThanOrEqual(4);
    expect(ctx.latest("source").track).toBe(
      (track as unknown as { _mediaStreamTrack: MediaStreamTrack })._mediaStreamTrack,
    );
    expect(sender.replaceTrack).toHaveBeenCalled();
    // One processor for the track's life: no graph was rebuilt.
    expect(contextOf(track)).toBe(ctx);
  });

  it("restarts without an audioContext, as the SDK's restart call site sends none (OC-0277)", async () => {
    const processor = createMicProcessor();
    await processor.init({
      kind: Track.Kind.Audio,
      track: fakeMediaStreamTrack("mic-a"),
    } as never);
    const before = processor.processedTrack;

    await processor.restart({
      kind: Track.Kind.Audio,
      track: fakeMediaStreamTrack("mic-b"),
    } as never);

    expect(processor.processedTrack).toBe(before);
    const ctx = processor.context as unknown as FakeAudioContext;
    expect(ctx.latest("source").track.id).toBe("mic-b");
  });

  it("keeps the push-to-talk gate closed on the output across a mute/unmute restart", async () => {
    const track = micTrack();
    const pipeline = new AudioPipeline();
    pipeline.setPttGated(true);
    await pipeline.attach(track);
    const ctx = contextOf(track);
    // The output gain (the entry gain is unity, before the chain).
    const gain = ctx.nodes.filter((n) => n.kind === "gain")[1]!.gain;
    expect(gain.value).toBe(0);

    await track.mute();
    await track.unmute();

    expect(gain.value).toBe(0);
    expect(track.mediaStreamTrack).toBe(ctx.outputTrack);
    pipeline.setPttGated(false);
    expect(gain.value).toBe(1);
  });
});
