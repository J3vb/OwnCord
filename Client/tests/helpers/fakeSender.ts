// A stand-in RTCRtpSender whose encodings a test can read and replace.
import { vi } from "vitest";

export interface FakeSender {
  readonly sender: RTCRtpSender;
  encodings: RTCRtpEncodingParameters[];
  readonly setParameters: ReturnType<typeof vi.fn>;
}

/** Layers are given lowest first, each as [scaleResolutionDownBy, maxBitrate]. */
export function fakeSender(
  layers: ReadonlyArray<readonly [number, number | undefined]>,
): FakeSender {
  const fake: FakeSender = {
    encodings: layers.map(([scaleResolutionDownBy, maxBitrate]) => ({
      scaleResolutionDownBy,
      ...(maxBitrate === undefined ? {} : { maxBitrate }),
    })),
    setParameters: vi.fn((params: RTCRtpSendParameters) => {
      fake.encodings = params.encodings.map((e) => ({ ...e }));
      return Promise.resolve();
    }),
    sender: undefined as never,
  };
  (fake as { sender: RTCRtpSender }).sender = {
    getParameters: () => ({ encodings: fake.encodings.map((e) => ({ ...e })) }),
    setParameters: fake.setParameters,
  } as unknown as RTCRtpSender;
  return fake;
}

export const bitrates = (fake: FakeSender): Array<number | undefined> =>
  fake.encodings.map((e) => e.maxBitrate);
