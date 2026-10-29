import { describe, expect, it } from "vitest";
import {
  bucketMax,
  decodeWaveform,
  encodeWaveform,
  formatClock,
  reducePeaks,
  WAVEFORM_BARS,
} from "./waveform";
import { clipExtension, clipFilename, pickRecorderMime, RECORDER_MIMES } from "./mime";
import { downsample, encodeWav } from "./wav";

describe("waveform reduce / encode / decode", () => {
  it("reduces many peaks to 64 bars with the loudest bar at 255", () => {
    const peaks = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 0.4 : 0.1));
    const bars = reducePeaks(peaks);
    expect(bars).toHaveLength(WAVEFORM_BARS);
    expect(Math.max(...bars)).toBe(255);
    expect(bars[Math.floor((500 * 64) / 1000)]).toBe(255);
    expect(bars[0]).toBe(Math.round((0.1 / 0.4) * 255));
  });

  it("stretches a short recording and keeps silence at zero", () => {
    expect(reducePeaks([0.2, 0.8])).toHaveLength(64);
    expect(Math.max(...reducePeaks([0.2, 0.8]))).toBe(255);
    expect(Array.from(reducePeaks([0, 0, 0]))).toEqual(Array.from({ length: 64 }, () => 0));
    expect(Array.from(reducePeaks([]))).toEqual(Array.from({ length: 64 }, () => 0));
  });

  it("round-trips through base64url without padding", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 4) % 256);
    const encoded = encodeWaveform(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(Array.from(decodeWaveform(encoded) ?? [])).toEqual(Array.from(bytes));
  });

  it("uses the url-safe alphabet for bytes that need + and /", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0xfe]);
    const encoded = encodeWaveform(bytes);
    expect(encoded).toContain("-");
    expect(Array.from(decodeWaveform(encoded) ?? [])).toEqual(Array.from(bytes));
  });

  it("rejects a malformed or oversized waveform", () => {
    expect(decodeWaveform("")).toBeNull();
    expect(decodeWaveform("not base64!")).toBeNull();
    expect(decodeWaveform(encodeWaveform(new Uint8Array(257)))).toBeNull();
    expect(decodeWaveform(encodeWaveform(new Uint8Array(256)))).toHaveLength(256);
  });

  it("takes the max per bucket", () => {
    expect(bucketMax([1, 5, 2, 3], 2)).toEqual([5, 3]);
  });

  it("formats m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(300)).toBe("5:00");
  });
});

describe("WAV encoder", () => {
  it("writes a 16 kHz mono 16-bit header and the right length", () => {
    // One second of 48 kHz audio becomes 16000 samples.
    const wav = encodeWav([new Float32Array(24_000), new Float32Array(24_000)], 48_000);
    expect(wav.length).toBe(44 + 16_000 * 2);
    const view = new DataView(wav.buffer);
    const tag = (at: number): string => String.fromCharCode(...wav.slice(at, at + 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(tag(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(32_000);
  });

  it("scales and clips samples to 16 bits", () => {
    const wav = encodeWav([Float32Array.from([1, -1, 0.5, 2])], 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
    expect(view.getInt16(48, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(view.getInt16(50, true)).toBe(0x7fff);
  });

  it("averages when downsampling and keeps a slower input as is", () => {
    expect(Array.from(downsample(Float32Array.from([1, 3, 5, 7]), 32_000, 16_000))).toEqual([2, 6]);
    const slow = Float32Array.from([1, 2]);
    expect(downsample(slow, 8_000, 16_000)).toBe(slow);
  });
});

const fake = (supported: string[]) => ({ isTypeSupported: (t: string) => supported.includes(t) });

describe("recorder mime pick", () => {
  it("takes the first supported in webm, ogg order", () => {
    expect(pickRecorderMime(fake([...RECORDER_MIMES]))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime(fake(["audio/ogg;codecs=opus", "audio/mp4"]))).toBe(
      "audio/ogg;codecs=opus",
    );
  });

  it("leaves an MP4-only recorder to the WAV fallback", () => {
    expect(pickRecorderMime(fake(["audio/mp4"]))).toBeNull();
  });

  it("is null without MediaRecorder or when it supports none", () => {
    expect(pickRecorderMime(undefined)).toBeNull();
    expect(pickRecorderMime(null)).toBeNull();
    expect(pickRecorderMime(fake([]))).toBeNull();
  });

  it("treats a throwing isTypeSupported as unsupported", () => {
    expect(
      pickRecorderMime({
        isTypeSupported: () => {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
  });

  it("names the file by container", () => {
    expect(clipFilename("audio/webm;codecs=opus")).toBe("voice-message.webm");
    expect(clipExtension("audio/ogg;codecs=opus")).toBe("ogg");
    expect(clipExtension("audio/mp4")).toBe("m4a");
    expect(clipExtension("audio/wav")).toBe("wav");
  });
});
