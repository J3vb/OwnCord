import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_CODES, EVENT_LOG_CAPS, type EventCode } from "./eventCodes";
import {
  clearEventLog,
  flushDroppedCounts,
  getEventLines,
  onEventLine,
  onEventLogCleared,
  record,
  resetEventLogForTests,
  sanitizeEvent,
  startEventLog,
} from "./eventLog";
import { recordEvent, setEventSinkEnabled } from "./eventSink";
import { pseudonym, reportHash, resetIdentifiersForTests } from "./identifiers";

const T0 = 1_762_185_600_000;

function parsed(): Record<string, unknown>[] {
  return getEventLines(T0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const micRate = (value: unknown) =>
  sanitizeEvent("mic.started", { sample_rate: value as number }, T0)["sample_rate"];
const cameraGap = (value: unknown) =>
  sanitizeEvent("camera.resumed", { gap_ms: value as number }, T0)["gap_ms"];
const voiceNative = (value: unknown) =>
  sanitizeEvent("voice.joined", { native: value as boolean }, T0)["native"];
const cameraEncoder = (value: unknown) =>
  sanitizeEvent("camera.stalled", { encoder: value as string }, T0)["encoder"];
const patterned = (code: "app.started" | "mic.started" | "voice.joined", name: string, v: string) =>
  sanitizeEvent(code, { [name]: v }, T0)[name];

describe("diagnostic event log", () => {
  beforeEach(() => {
    resetEventLogForTests();
    setEventSinkEnabled(true);
  });
  afterEach(() => {
    resetEventLogForTests();
    setEventSinkEnabled(true);
    vi.useRealTimers();
  });

  it("keeps only allowlisted fields that pass their type check", () => {
    const event = sanitizeEvent(
      "camera.stalled",
      {
        frames_sent: 120.4,
        encoder: "ExternalEncoder (MediaFoundation)",
        hardware_encoder: true,
        quality_limitation: "cpu",
        width: "1280",
        label: "Alex's iPhone",
        message: "hello",
      },
      T0,
    );
    expect(event).toEqual({
      t: T0,
      code: "camera.stalled",
      frames_sent: 120,
      hardware_encoder: true,
      quality_limitation: "cpu",
    });
  });

  it("rounds a finite number and drops a non-finite or mistyped one, per field type", () => {
    expect(micRate(48000.6)).toBe(48001);
    expect(micRate(-3.4)).toBe(-3);
    expect(micRate(Number.NaN)).toBeUndefined();
    expect(micRate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(micRate("48000")).toBeUndefined();

    expect(cameraGap(0)).toBe(0);
    expect(cameraGap(12.5)).toBe(13);
    expect(cameraGap(Number.NaN)).toBeUndefined();
    expect(cameraGap("5")).toBeUndefined();

    expect(voiceNative(false)).toBe(false);
    expect(voiceNative(1)).toBeUndefined();
  });

  it("holds a version, token, hash and pseudonym to its pattern", () => {
    expect(patterned("app.started", "app_version", "1.2.3")).toBe("1.2.3");
    expect(patterned("app.started", "app_version", "1.2.3-beta")).toBeUndefined();
    expect(patterned("mic.started", "device", "0a1b2c3d")).toBe("0a1b2c3d");
    expect(patterned("mic.started", "device", "0A1B2C3D")).toBeUndefined();
    expect(patterned("voice.joined", "channel", "c12")).toBe("c12");
    expect(patterned("voice.joined", "channel", "12c")).toBeUndefined();
    expect(cameraEncoder("x264_v1.2")).toBe("x264_v1.2");
    expect(cameraEncoder("has space")).toBeUndefined();
    expect(cameraEncoder(7)).toBeUndefined();
  });

  it("rejects an enum word outside its list, a negative duration and a URL host", () => {
    expect(sanitizeEvent("ws.closed", { close_class: "teapot", generation: 2 }, T0)).toEqual({
      t: T0,
      code: "ws.closed",
      generation: 2,
    });
    expect(sanitizeEvent("camera.resumed", { gap_ms: -5 }, T0)).toEqual({
      t: T0,
      code: "camera.resumed",
    });
    for (const host of ["https://chat.example.org/x", "chat.example.org:8443", "10.0.0.2"]) {
      expect(sanitizeEvent("ws.connecting", { host }, T0)).not.toHaveProperty("host");
    }
    expect(sanitizeEvent("ws.connecting", { host: "chat.example.org" }, T0)).toHaveProperty(
      "host",
      "chat.example.org",
    );
    expect(sanitizeEvent("events.dropped", { dropped_code: "not.a_code" }, T0)).not.toHaveProperty(
      "dropped_code",
    );
  });

  it("queues events recorded before it starts, then records them in order", () => {
    vi.useFakeTimers({ now: T0 });
    recordEvent("ws.open", { generation: 1 });
    recordEvent("ws.ready", { generation: 1, after_ms: 40 });
    startEventLog();
    recordEvent("ws.closed", { generation: 1, close_class: "abnormal" });
    expect(parsed().map((e) => e.code)).toEqual(["ws.open", "ws.ready", "ws.closed"]);
  });

  it("records nothing while turned off, and clearing tells the disk writer", () => {
    startEventLog();
    const cleared = vi.fn();
    onEventLogCleared(cleared);
    record("ws.open", { generation: 1 }, T0);
    setEventSinkEnabled(false);
    recordEvent("ws.open", { generation: 2 });
    clearEventLog();
    expect(getEventLines(T0)).toEqual([]);
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("passes every stored line to its listeners", () => {
    const lines: string[] = [];
    onEventLine((line) => lines.push(line));
    record("app.network", { state: "offline" }, T0);
    expect(lines).toEqual([JSON.stringify({ t: T0, code: "app.network", state: "offline" })]);
  });

  it("limits a burst per code and counts the rest in one events.dropped line", () => {
    record("app.network", { state: "online" }, T0);
    for (let i = 0; i < 100; i++) {
      record("ws.reconnect_scheduled", { generation: 1, attempt: i, delay_ms: 100 }, T0 + i);
    }
    const events = parsed();
    expect(events[0]!.code).toBe("app.network");
    expect(events.filter((e) => e.code === "ws.reconnect_scheduled")).toHaveLength(
      EVENT_LOG_CAPS.perCodePerMinute,
    );
    expect(events.at(-1)).toMatchObject({
      code: "events.dropped",
      dropped_code: "ws.reconnect_scheduled",
      count: 100 - EVENT_LOG_CAPS.perCodePerMinute,
    });
  });

  it("starts a fresh window after a minute and reports what the old one dropped", () => {
    for (let i = 0; i < 35; i++) record("app.network", { state: "online" }, T0 + i);
    record("app.network", { state: "offline" }, T0 + 61_000);
    const events = getEventLines(T0 + 61_000).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.at(-2)).toMatchObject({ code: "events.dropped", count: 5 });
    expect(events.at(-1)).toMatchObject({ code: "app.network", state: "offline" });
  });

  it("hands pending drop counts to listeners when asked, without a new event", () => {
    const lines: string[] = [];
    onEventLine((line) => lines.push(line));
    for (let i = 0; i < 40; i++) record("app.network", { state: "online" }, T0 + i);
    flushDroppedCounts(T0 + 100);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: "events.dropped", count: 10 });
    flushDroppedCounts(T0 + 200);
    expect(lines.filter((l) => l.includes("events.dropped"))).toHaveLength(1);
  });

  it("keeps at most the event cap, oldest dropped first", () => {
    // Many codes inside one minute, so neither the rate limit nor the age cap bites.
    const codes = (Object.keys(EVENT_CODES) as EventCode[]).filter((c) => c !== "events.dropped");
    const total = EVENT_LOG_CAPS.maxEvents + 50;
    const perWindow = codes.length * EVENT_LOG_CAPS.perCodePerMinute;
    let at = T0;
    for (let i = 0; i < total; i++) {
      at = T0 + Math.floor(i / perWindow) * 61_000 + i;
      record(codes[i % codes.length]!, {}, at);
    }
    const lines = getEventLines(at);
    expect(lines).toHaveLength(EVENT_LOG_CAPS.maxEvents);
    expect((JSON.parse(lines[0]!) as { t: number }).t).toBeGreaterThan(T0);
  });

  it("drops events older than the age cap", () => {
    record("ws.open", { generation: 1 }, T0);
    record("ws.open", { generation: 2 }, T0 + EVENT_LOG_CAPS.maxAgeMs + 1_000);
    const lines = getEventLines(T0 + EVENT_LOG_CAPS.maxAgeMs + 1_000);
    expect(lines.map((l) => (JSON.parse(l) as { generation: number }).generation)).toEqual([2]);
  });

  it("keeps the ring under the byte cap", () => {
    for (let i = 0; i < 10_000; i++) {
      record(
        "camera.resumed",
        { frames_sent: i, encoder: "x".repeat(48), width: 1920, height: 1080, gap_ms: 5000 },
        T0 + i * 2_100,
      );
    }
    const lines = getEventLines(T0 + 10_000 * 2_100);
    const bytes = lines.reduce((sum, l) => sum + l.length, 0);
    expect(bytes).toBeLessThanOrEqual(EVENT_LOG_CAPS.maxBytes);
  });
});

describe("report identifiers", () => {
  beforeEach(() => resetIdentifiersForTests());

  it("hashes a label to 8 hex characters, the same within a run", () => {
    const a = reportHash("Alex's iPhone");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(reportHash("Alex's iPhone")).toBe(a);
    expect(reportHash("Other camera")).not.toBe(a);
  });

  it("gives each id a stable short pseudonym", () => {
    expect(pseudonym("u", "42")).toBe("u1");
    expect(pseudonym("u", 7)).toBe("u2");
    expect(pseudonym("u", "42")).toBe("u1");
    expect(pseudonym("c", 42)).toBe("c1");
  });
});
