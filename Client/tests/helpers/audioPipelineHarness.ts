import { LocalAudioTrack, Track } from "livekit-client";
import type { MicProcessor } from "../../src/lib/voice/micProcessor";
import { FakeAudioContext, FakeAudioWorkletNode, fakeMediaStreamTrack } from "./fakeAudioContext";

export function micTrack(): LocalAudioTrack {
  const track = new LocalAudioTrack(fakeMediaStreamTrack("mic"), undefined, false);
  track.source = Track.Source.Microphone;
  return track;
}

export const contextOf = (track: LocalAudioTrack): FakeAudioContext =>
  (track.getProcessor() as unknown as MicProcessor).context as unknown as FakeAudioContext;

/** Input Volume rides on the first gain node, ahead of the detector's tap. */
export const inputGain = (ctx: FakeAudioContext) =>
  ctx.nodes.filter((n) => n.kind === "gain")[0]!.gain;

export const outputGain = (ctx: FakeAudioContext) =>
  ctx.nodes.filter((n) => n.kind === "gain")[1]!.gain;

export function roomWith(track: LocalAudioTrack | undefined) {
  return {
    localParticipant: {
      getTrackPublication: (source: string) =>
        source === Track.Source.Microphone && track !== undefined ? { track } : undefined,
    },
  } as never;
}

export const rnnoise = () =>
  FakeAudioWorkletNode.instances.find((w) => w.name === "rnnoise-processor");
