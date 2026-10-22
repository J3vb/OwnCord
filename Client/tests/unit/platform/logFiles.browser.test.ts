// The browser log files (6.13d): a bounded memory ring. The `logPersistence`
// suite describes files in a directory (`getDir` is a string after `init`), so
// it does not bind here; these tests pin the ring in its place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLogBuffer, createLogger } from "@lib/logger";
import type { LogFiles } from "../../../src/platform/contracts/logFiles";
import { RING_CAPACITY, logFiles as ring } from "../../../src/platform/browser/logFiles";

// Imported once, not per test: the logger registers a page listener as it
// loads, which the lifecycle guard counts against a test that loads it.
async function load(): Promise<{ logFiles: LogFiles; capacity: number }> {
  await ring.clearAll();
  clearLogBuffer();
  return { logFiles: ring, capacity: RING_CAPACITY };
}

const cleanups: (() => void)[] = [];

async function started(logFiles: LogFiles): Promise<void> {
  cleanups.push(await logFiles.init());
}

// The logger echoes to the console; these tests log on purpose.
beforeEach(() => {
  for (const level of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of cleanups.splice(0)) stop();
});

async function lines(logFiles: LogFiles): Promise<string[]> {
  const files = await logFiles.readAll();
  return files.flatMap((file) => file.text.split("\n").filter((line) => line !== ""));
}

describe("browser log files", () => {
  it("has no directory and no folder to open", async () => {
    const { logFiles } = await load();
    await started(logFiles);
    expect(logFiles.getDir()).toBeNull();
    expect(await logFiles.openFolder()).toMatchObject({ ok: false });
    expect(await logFiles.readNative()).toEqual([]);
    await expect(logFiles.flush()).resolves.toBeUndefined();
    await expect(logFiles.clearPending()).resolves.toBeUndefined();
  });

  it("reads back nothing before anything is logged", async () => {
    const { logFiles } = await load();
    expect(await logFiles.readAll()).toEqual([]);
  });

  it("keeps what is logged after init, as one JSON line per entry", async () => {
    const { logFiles } = await load();
    await started(logFiles);
    createLogger("ring-test").warn("first", { n: 1 });
    createLogger("ring-test").error("second");
    const read = (await lines(logFiles)).map((line) => JSON.parse(line) as { message: string });
    expect(read.map((entry) => entry.message)).toEqual(["first", "second"]);
    expect((await logFiles.readAll())[0]!.name).toMatch(/\.jsonl$/);
  });

  it("includes entries logged before init", async () => {
    const { logFiles } = await load();
    createLogger("early").warn("before init");
    await started(logFiles);
    expect(await lines(logFiles)).toHaveLength(1);
    expect((await lines(logFiles))[0]).toContain("before init");
  });

  it("stops recording once the cleanup runs", async () => {
    const { logFiles } = await load();
    const stop = await logFiles.init();
    createLogger("t").warn("kept");
    stop();
    createLogger("t").warn("dropped");
    expect(await lines(logFiles)).toHaveLength(1);
  });

  it("is bounded: the oldest lines go first", async () => {
    const { logFiles, capacity } = await load();
    await started(logFiles);
    const log = createLogger("flood");
    for (let i = 0; i < capacity + 25; i++) log.warn(`line ${i}`);
    const read = await lines(logFiles);
    expect(read).toHaveLength(capacity);
    expect(read[0]).toContain("line 25");
    expect(read.at(-1)).toContain(`line ${capacity + 24}`);
  });

  it("clearAll empties the ring but keeps recording", async () => {
    const { logFiles } = await load();
    await started(logFiles);
    createLogger("t").warn("old");
    await logFiles.clearAll();
    expect(await logFiles.readAll()).toEqual([]);
    createLogger("t").warn("new");
    expect(await lines(logFiles)).toHaveLength(1);
  });
});
