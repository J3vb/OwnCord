// The speech worker's own rules, with scripted models in place of the real
// ones: whose verdict reaches the gate, when the second model rests, and what
// starts both over.
import { afterEach, describe, expect, it, vi } from "vitest";

interface Reply {
  frame: number;
  probability: number;
  peak: number;
}
interface Port {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(reply: Reply): void;
  close(): void;
}
interface WorkerScope {
  onmessage: ((event: { data: { port: Port } }) => void) | null;
  postMessage(message: unknown): void;
}

const fake = vi.hoisted(() => ({
  /** What the first and the second model answer next. */
  scores: [0, 0] as [number, number],
  /** Every model call in order, a scored frame named by its level x 10,000. */
  calls: [] as string[],
  /** The first sample of each frame the first model scored. */
  starts: [] as number[],
  options: [] as unknown[],
  table: new Float32Array(1),
}));

vi.mock("../../public/silero-vad.js", () => ({
  FRAME_SAMPLES: 512,
  createSileroVad: (_bytes: ArrayBuffer, options?: unknown) => {
    const index = fake.options.push(options) - 1;
    const name = index === 0 ? "first" : "second";
    return {
      stftBasis: fake.table,
      reset: () => {
        fake.calls.push(`${name}.reset`);
      },
      score: (frame: Float32Array) => {
        if (index === 0) fake.starts.push(frame[0]!);
        fake.calls.push(`${name}.score ${Math.round(frame[511]! * 1e4)}`);
        return fake.scores[index];
      },
    };
  },
}));

const QUIET = 0.0005;
const LOUD = 0.02;
const FRAME = 1536;

async function startWorker(missingFile?: string) {
  fake.scores = [0, 0];
  fake.calls.length = 0;
  fake.starts.length = 0;
  fake.options.length = 0;
  const messages: unknown[] = [];
  const scope: WorkerScope = { onmessage: null, postMessage: (message) => messages.push(message) };
  const fetched: string[] = [];
  vi.stubGlobal("self", scope);
  vi.stubGlobal("fetch", (url: URL) => {
    const file = url.pathname.split("/").pop() ?? "";
    fetched.push(file);
    return Promise.resolve(
      file === missingFile
        ? { ok: false, status: 404 }
        : { ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) },
    );
  });
  vi.resetModules();
  // @ts-expect-error The packaged worker is a JavaScript module.
  await import("../../public/silero-vad-worker.js");
  const replies: Reply[] = [];
  const port: Port = {
    onmessage: null,
    postMessage: (reply) => replies.push(reply),
    close: vi.fn(),
  };
  scope.onmessage?.({ data: { port } });
  await vi.waitFor(() => expect(messages).toHaveLength(1));
  let next = 0;
  const post = (samples: Float32Array, threshold?: number): Reply | undefined => {
    port.onmessage?.({ data: { frame: next++, samples, peak: 0.5, threshold } });
    return replies.at(-1);
  };
  return {
    messages,
    fetched,
    port,
    post,
    /** One frame at a constant level. */
    send: (level: number, threshold?: number) =>
      post(new Float32Array(FRAME).fill(level), threshold),
    skipFrame: () => next++,
    secondModelScores: () => fake.calls.filter((call) => call.startsWith("second.score")).length,
  };
}

describe("Silero speech worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads both models and gives the second its rest state and the first's STFT table", async () => {
    const worker = await startWorker();
    expect(worker.messages).toEqual([{ type: "ready" }]);
    expect(worker.fetched.toSorted()).toEqual(["silero-v5.1.2.bin", "silero-v6.2.0-slim.bin"]);
    expect(fake.options).toEqual([undefined, { restFrames: 7, stftBasis: fake.table }]);
  });

  it("answers with the first model's score, or with 1 when the second hears speech", async () => {
    const worker = await startWorker();
    fake.scores = [0.2, 0.89];
    expect(worker.send(LOUD)).toEqual({ frame: 0, probability: 0.2, peak: 0.5 });
    fake.scores = [0.2, 0.9];
    expect(worker.send(LOUD)).toEqual({ frame: 1, probability: 1, peak: 0.5 });
    fake.scores = [0.6, 0];
    expect(worker.send(LOUD)).toEqual({ frame: 2, probability: 0.6, peak: 0.5 });
  });

  it("rests the second model after half a second of quiet and wakes it from its rest state", async () => {
    const worker = await startWorker();
    for (let i = 0; i < 15; i++) worker.send(QUIET);
    expect(worker.secondModelScores()).toBe(15);

    fake.calls.length = 0;
    fake.scores = [0.3, 0.99];
    expect(worker.send(0.0007)?.probability).toBe(0.3);
    worker.send(0.0009);
    expect(fake.calls).toEqual(["first.score 7", "first.score 9"]);

    // The sound that ends the quiet is scored behind the last quiet frame.
    fake.calls.length = 0;
    expect(worker.send(LOUD)?.probability).toBe(1);
    expect(fake.calls).toEqual([
      "first.score 200",
      "second.reset",
      "second.score 9",
      "second.score 200",
    ]);
  });

  it("leaves the second model's memory running through a shorter pause", async () => {
    const worker = await startWorker();
    for (let i = 0; i < 15; i++) worker.send(QUIET);
    worker.send(LOUD);
    for (let i = 0; i < 15; i++) worker.send(QUIET);
    worker.send(LOUD);
    expect(fake.calls).not.toContain("second.reset");
    expect(worker.secondModelScores()).toBe(32);
  });

  it("counts a frame with 8 ms of sound in it as sound", async () => {
    const worker = await startWorker();
    for (let i = 0; i < 16; i++) worker.send(QUIET);
    // 8 ms at -50 dBFS: over the bound on its own, under it averaged over the frame.
    const frame = new Float32Array(FRAME).fill(QUIET);
    frame.fill(0.003, 768, 1152);
    fake.calls.length = 0;
    worker.post(frame);
    expect(fake.calls.slice(1, 3)).toEqual(["second.reset", "second.score 5"]);
  });

  // The bound is -55 dBFS (0.0018), or the gate threshold when that is lower.
  // The second model scores all 17 frames of a sound and 15 of a quiet.
  it.each([
    ["under -55 dBFS, no threshold (an older worklet)", 0.0015, undefined, 15],
    ["under -55 dBFS and under the threshold", 0.0015, 0.01, 15],
    ["over -55 dBFS, although under the threshold", 0.005, 0.01, 17],
    ["under -55 dBFS, but over the threshold", 0.0015, 0.001, 17],
  ])("takes a level %s as told", async (_case, level, threshold, scored) => {
    const worker = await startWorker();
    for (let i = 0; i < 17; i++) worker.send(level, threshold);
    expect(worker.secondModelScores()).toBe(scored);
  });

  it("starts both models and the quiet count over after a skipped frame", async () => {
    const worker = await startWorker();
    for (let i = 0; i < 15; i++) worker.send(QUIET);
    worker.skipFrame();
    fake.calls.length = 0;
    // Without the gap this would be the frame that sends the second model to rest.
    worker.send(QUIET);
    expect(fake.calls).toEqual(["first.reset", "second.reset", "first.score 5", "second.score 5"]);
    // The resampler starts over as well: the frame fades in from silence
    // instead of running on from the frame before the gap.
    expect(fake.starts.at(-2)).toBeCloseTo(QUIET, 6);
    expect(fake.starts.at(-1)).toBeLessThan(QUIET / 100);
  });

  it("reports a frame of the wrong length and closes the port", async () => {
    const worker = await startWorker();
    worker.post(new Float32Array(FRAME - 1));
    expect(worker.messages[1]).toEqual({
      type: "error",
      message: "Error: Invalid Silero input frame",
    });
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["first", [Number.NaN, 0]],
    ["second", [0, Number.NaN]],
  ] as const)(
    "reports a %s model score that is no number and closes the port",
    async (_, scores) => {
      const worker = await startWorker();
      fake.scores = [...scores];
      expect(worker.send(LOUD)).toBeUndefined();
      expect(worker.messages[1]).toEqual({ type: "error", message: "Error: Invalid Silero score" });
      expect(worker.port.close).toHaveBeenCalledOnce();
    },
  );

  it("does not start without the second model's file", async () => {
    const worker = await startWorker("silero-v6.2.0-slim.bin");
    expect(worker.messages).toEqual([{ type: "error", message: "Error: Silero model HTTP 404" }]);
    expect(worker.port.close).toHaveBeenCalledOnce();
  });
});
