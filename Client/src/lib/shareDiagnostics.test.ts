import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHARE_RING_MAX_BYTES,
  SHARE_RING_MAX_SAMPLES,
  ShareDiagnosticsRecorder,
  type RecorderDeps,
} from "./shareDiagnostics";
import type { StreamSample } from "../features/voice/remoteTracks";
import type { ShareSenderSample } from "../features/voice/shareSenderStats";

const SENDER: ShareSenderSample = { captureFps: 30, sentFps: 29, width: 1920, height: 1080 };
const VIEWER: StreamSample = { timestamp: 1, framesDecoded: 10, framesDropped: 1 };

interface Harness {
  deps: RecorderDeps;
  readSender: ReturnType<typeof vi.fn<() => Promise<ShareSenderSample | null>>>;
  readViewer: ReturnType<typeof vi.fn<(id: number) => Promise<StreamSample | null>>>;
  state: { enabled: boolean; epoch: object | undefined; watched: number[]; policy: string };
}

function harness(): Harness {
  const state = {
    enabled: true,
    epoch: {} as object | undefined,
    watched: [] as number[],
    policy: "legacy",
  };
  const readSender = vi.fn<() => Promise<ShareSenderSample | null>>(async () => SENDER);
  const readViewer = vi.fn<(id: number) => Promise<StreamSample | null>>(async () => VIEWER);
  const deps: RecorderDeps = {
    enabled: () => state.enabled,
    policy: () => state.policy,
    shareEpoch: () => state.epoch,
    readSender,
    watchedShares: () => state.watched,
    readViewer,
    now: () => performance.now(),
  };
  return { deps, readSender, readViewer, state };
}

describe("ShareDiagnosticsRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at 1 Hz and records sender and viewers", async () => {
    const h = harness();
    h.state.watched = [7];
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(3000);
    const snap = rec.snapshot();
    expect(snap.samples).toHaveLength(3);
    expect(snap.samples.map((s) => s.t)).toEqual([1000, 2000, 3000]);
    expect(snap.samples[0]).toMatchObject({
      shareGeneration: 1,
      policy: "legacy",
      policyVersion: "2c-1",
      sender: SENDER,
    });
    expect(snap.samples[0]?.viewers).toEqual([
      { userId: 7, sample: expect.objectContaining({ framesDropped: 1 }) },
    ]);
    expect(snap.dropped).toBe(0);
    ac.abort();
  });

  it("labels a share with the test mode it started under, not a later pick", async () => {
    const h = harness();
    h.state.policy = "motion-balanced";
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(1000);
    // Picked mid-share: it only applies to the next share.
    h.state.policy = "legacy";
    await vi.advanceTimersByTimeAsync(1000);
    expect(rec.snapshot().samples.map((s) => s.policy)).toEqual([
      "motion-balanced",
      "motion-balanced",
    ]);
    expect(rec.snapshot().policy).toBe("motion-balanced");
    // The next share picks it up.
    h.state.epoch = {};
    await vi.advanceTimersByTimeAsync(1000);
    expect(rec.snapshot().samples.at(-1)).toMatchObject({ shareGeneration: 2, policy: "legacy" });
    ac.abort();
  });

  it("keeps t and startedAt on one origin when sharing starts late", async () => {
    const h = harness();
    h.state.epoch = undefined;
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    h.state.epoch = {};
    await vi.advanceTimersByTimeAsync(1000);
    const snap = rec.snapshot();
    expect(snap.startedAt).toBe("2026-10-28T10:00:00.000Z");
    expect(snap.samples[0]?.t).toBe(61_000);
    ac.abort();
  });

  it("does not overlap polls when a read is slow", async () => {
    const h = harness();
    h.readSender.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(SENDER), 3000)),
    );
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.readSender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(rec.snapshot().samples).toHaveLength(1);
    ac.abort();
  });

  it("reads nothing while disabled or with nothing to watch", async () => {
    const h = harness();
    h.state.enabled = false;
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.readSender).not.toHaveBeenCalled();
    h.state.enabled = true;
    h.state.epoch = undefined;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.readSender).not.toHaveBeenCalled();
    expect(h.readViewer).not.toHaveBeenCalled();
    expect(rec.snapshot().samples).toHaveLength(0);
    h.state.watched = [4];
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.readViewer).toHaveBeenCalledWith(4);
    expect(h.readSender).not.toHaveBeenCalled();
    expect(rec.snapshot().samples[0]?.sender).toBeNull();
    ac.abort();
  });

  it("keeps 180 samples and counts what it dropped", async () => {
    const h = harness();
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync((SHARE_RING_MAX_SAMPLES + 1) * 1000);
    const snap = rec.snapshot();
    expect(snap.samples).toHaveLength(SHARE_RING_MAX_SAMPLES);
    expect(snap.dropped).toBe(1);
    expect(snap.samples[0]?.t).toBe(2000);
    ac.abort();
  });

  it("caps the ring by bytes without stopping the polling", async () => {
    const h = harness();
    const big = "x".repeat(400 * 1024);
    h.readSender.mockResolvedValue({ encoder: big });
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const snap = rec.snapshot();
    expect(h.readSender).toHaveBeenCalledTimes(10);
    expect(snap.samples).toHaveLength(5);
    expect(JSON.stringify(snap.samples).length).toBeLessThanOrEqual(SHARE_RING_MAX_BYTES + 10);
    expect(snap.dropped).toBe(5);
    ac.abort();
  });

  it("drops a sender read that resolves after the share changed", async () => {
    const h = harness();
    const pending: { release: (v: ShareSenderSample) => void } = { release: () => {} };
    h.readSender.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pending.release = resolve;
        }),
    );
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(1000);
    h.state.epoch = {};
    pending.release(SENDER);
    await vi.advanceTimersByTimeAsync(0);
    const first = rec.snapshot().samples[0];
    expect(first?.sender).toBeNull();
    expect(first?.shareGeneration).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const second = rec.snapshot().samples[1];
    expect(second?.shareGeneration).toBe(2);
    expect(second?.sender).toEqual(SENDER);
    ac.abort();
  });

  it("stops for good on abort and leaves no timer", async () => {
    const h = harness();
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(2000);
    ac.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.readSender).toHaveBeenCalledTimes(2);
  });

  it("leaves no timer when aborted mid-read and records nothing for it", async () => {
    const h = harness();
    h.readSender.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(SENDER), 500)),
    );
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(1100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(rec.snapshot().samples).toHaveLength(0);
  });

  it("records null for a rejecting read and keeps polling", async () => {
    const h = harness();
    h.state.watched = [7];
    h.readSender.mockRejectedValueOnce(new Error("boom"));
    h.readViewer.mockRejectedValueOnce(new Error("boom"));
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(2000);
    const [a, b] = rec.snapshot().samples;
    expect(a?.sender).toBeNull();
    expect(a?.viewers).toEqual([]);
    expect(b?.sender).toEqual(SENDER);
    expect(b?.viewers).toHaveLength(1);
    ac.abort();
  });

  it("clear empties the ring", async () => {
    const h = harness();
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(2000);
    rec.clear();
    expect(rec.snapshot()).toMatchObject({ samples: [], dropped: 0 });
    ac.abort();
  });

  it("records only the allowlisted viewer fields", async () => {
    const h = harness();
    h.state.watched = [7];
    h.readViewer.mockResolvedValue({
      timestamp: 5,
      framesDecoded: 2,
      secret: "token",
    } as unknown as StreamSample);
    const rec = new ShareDiagnosticsRecorder(h.deps);
    const ac = new AbortController();
    rec.start(ac.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(rec.snapshot())).not.toContain("token");
    ac.abort();
  });
});
