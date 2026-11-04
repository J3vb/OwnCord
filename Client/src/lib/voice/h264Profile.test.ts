import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsole } from "../../../tests/helpers/console";

const CBP = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const BASELINE = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f";
const MAIN = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f";
const HIGH = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034";

const codec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({
  mimeType,
  clockRate: 90000,
  ...(sdpFmtpLine === undefined ? {} : { sdpFmtpLine }),
});
const VP8 = codec("video/VP8");
const VP9 = codec("video/VP9", "profile-id=0");
const RTX = codec("video/rtx", "apt=96");
const CAPABILITIES: RTCRtpCodec[] = [
  VP8,
  RTX,
  codec("video/H264", BASELINE),
  codec("video/H264", CBP),
  codec("video/H264", MAIN),
  VP9,
  codec("video/H264", HIGH),
];

interface FakeTransceiver {
  sender: { track: MediaStreamTrack | null };
  setCodecPreferences: ReturnType<typeof vi.fn>;
}

const transceivers: FakeTransceiver[] = [];
const offers = vi.fn(() => Promise.resolve({ type: "offer", sdp: "v=0" }));

class FakePeerConnection {
  getTransceivers(): FakeTransceiver[] {
    return transceivers;
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return offers() as Promise<RTCSessionDescriptionInit>;
  }
}

vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: CAPABILITIES }) });

const { setH264GpuProfiles, nonBaselineH264Order, gpuH264SizeCap, fitGpuH264Share } =
  await import("./h264Profile");

function videoTrack(): MediaStreamTrack {
  return { kind: "video" } as MediaStreamTrack;
}

function transceiver(track: MediaStreamTrack | null): FakeTransceiver {
  const t = { sender: { track }, setCodecPreferences: vi.fn() };
  transceivers.push(t);
  return t;
}

async function offer(): Promise<void> {
  const pc = new FakePeerConnection() as unknown as RTCPeerConnection;
  await pc.createOffer();
}

beforeEach(() => {
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: CAPABILITIES }) });
  transceivers.length = 0;
  offers.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("nonBaselineH264Order", () => {
  it("puts Main and High first, drops Baseline, and keeps every other codec after them", () => {
    expect(nonBaselineH264Order(CAPABILITIES)).toEqual([
      codec("video/H264", MAIN),
      codec("video/H264", HIGH),
      VP8,
      RTX,
      VP9,
    ]);
  });

  it("is null when H.264 has only Baseline profiles, so H.264 is not dropped", () => {
    expect(nonBaselineH264Order([VP8, codec("video/H264", CBP), codec("video/H264")])).toBeNull();
  });

  it("treats an H.264 line without profile-level-id as Constrained Baseline", () => {
    expect(nonBaselineH264Order([codec("video/H264", "packetization-mode=1"), VP8])).toBeNull();
  });
});

describe("setH264GpuProfiles", () => {
  it("narrows an H.264 track's transceiver on the offer, then lets the offer go on", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);

    await offer();

    expect(t.setCodecPreferences).toHaveBeenCalledWith(nonBaselineH264Order(CAPABILITIES));
    expect(offers).toHaveBeenCalledTimes(1);
  });

  it("narrows again on a renegotiation or ICE restart offer while the share runs", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);

    await offer();
    await offer();

    expect(t.setCodecPreferences).toHaveBeenCalledTimes(2);
  });

  it("stops narrowing once the track is unmarked (the live switch republishes it as VP8)", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);
    await offer();
    t.setCodecPreferences.mockClear();

    setH264GpuProfiles(track, false);
    await offer();

    expect(t.setCodecPreferences).not.toHaveBeenCalled();
  });

  it("keeps a transceiver narrowed when Change source replaces its track", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);
    await offer();
    t.setCodecPreferences.mockClear();

    t.sender.track = videoTrack();
    await offer();

    expect(t.setCodecPreferences).not.toHaveBeenCalled();
  });

  it("restores the default preferences once the track is unpublished, so a reuse is not narrowed", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);
    await offer();
    t.setCodecPreferences.mockClear();

    t.sender.track = null;
    await offer();
    await offer();

    expect(t.setCodecPreferences).toHaveBeenCalledTimes(1);
    expect(t.setCodecPreferences).toHaveBeenCalledWith([]);
  });

  it("leaves an audio transceiver alone", async () => {
    const track = { kind: "audio" } as MediaStreamTrack;
    const t = transceiver(track);
    setH264GpuProfiles(track, true);

    await offer();

    expect(t.setCodecPreferences).not.toHaveBeenCalled();
  });

  it("keeps the browser's preferences when it has no Main or High to offer", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({ codecs: [VP8, codec("video/H264", CBP)] }),
    });
    const track = videoTrack();
    const t = transceiver(track);
    setH264GpuProfiles(track, true);

    await offer();

    expect(t.setCodecPreferences).not.toHaveBeenCalled();
    expect(offers).toHaveBeenCalledTimes(1);
  });

  it("does not touch a transceiver it never narrowed", async () => {
    const t = transceiver(null);
    setH264GpuProfiles(videoTrack(), true);

    await offer();

    expect(t.setCodecPreferences).not.toHaveBeenCalled();
  });

  it("still sends the offer when the browser refuses the preferences", async () => {
    const track = videoTrack();
    const t = transceiver(track);
    t.setCodecPreferences.mockImplementation(() => {
      throw new DOMException("bad codec", "InvalidModificationError");
    });
    setH264GpuProfiles(track, true);

    await expect(offer()).resolves.toBeUndefined();
    expectConsole("warn", "Could not prefer H.264 Main/High");
    expect(offers).toHaveBeenCalledTimes(1);
  });
});

describe("gpuH264SizeCap", () => {
  it("holds Source to the GPU encoder's 3840x2160", () => {
    expect(gpuH264SizeCap()).toEqual({ width: 3840, height: 2160 });
  });

  it("keeps a preset that already fits", () => {
    expect(gpuH264SizeCap({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });
});

function capture(
  dims: { width: number; height: number } | Promise<{ width: number; height: number }>,
  settings: MediaTrackSettings = {},
) {
  const applyConstraints = vi.fn<(c: MediaTrackConstraints) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const mediaStreamTrack = {
    getSettings: () => settings,
    applyConstraints,
  } as unknown as MediaStreamTrack;
  const waitForDimensions = vi.fn(() => Promise.resolve(dims));
  return { share: { mediaStreamTrack, waitForDimensions }, applyConstraints };
}

describe("fitGpuH264Share", () => {
  it("shrinks a 5120x1440 screen to the GPU encoder's limit and keeps its 60 fps", async () => {
    const { share, applyConstraints } = capture(
      { width: 5120, height: 1440 },
      { width: 5120, height: 1440, frameRate: 60 },
    );

    await fitGpuH264Share(share);

    expect(applyConstraints).toHaveBeenCalledExactlyOnceWith({
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: 60,
    });
  });

  it("waits for a size the capture reports only after its first frame", async () => {
    let report!: (d: { width: number; height: number }) => void;
    const later = new Promise<{ width: number; height: number }>((r) => (report = r));
    const { share, applyConstraints } = capture(later, { frameRate: 60 });

    const fitting = fitGpuH264Share(share);
    await Promise.resolve();
    expect(applyConstraints).not.toHaveBeenCalled();
    report({ width: 5120, height: 1440 });
    await fitting;

    expect(applyConstraints).toHaveBeenCalledExactlyOnceWith({
      width: { max: 3840 },
      height: { max: 2160 },
      frameRate: 60,
    });
  });

  it("leaves a capture that already fits alone", async () => {
    const { share, applyConstraints } = capture({ width: 3840, height: 2160 }, { frameRate: 30 });

    await fitGpuH264Share(share);

    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it("logs a capture whose size never arrives and leaves it alone", async () => {
    const { share, applyConstraints } = capture({ width: 0, height: 0 });
    share.waitForDimensions.mockRejectedValueOnce(new Error("unable to get track dimensions"));

    await expect(fitGpuH264Share(share)).resolves.toBeUndefined();
    expectConsole("warn", "Screen share size unknown");
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it("logs a refusal and lets the share go on at full size", async () => {
    const { share, applyConstraints } = capture({ width: 5120, height: 1440 });
    applyConstraints.mockRejectedValueOnce(new DOMException("over", "OverconstrainedError"));

    await expect(fitGpuH264Share(share)).resolves.toBeUndefined();
    expectConsole("warn", "Could not shrink the screen share");
    expect(applyConstraints).toHaveBeenCalledWith({ width: { max: 3840 }, height: { max: 2160 } });
  });
});
