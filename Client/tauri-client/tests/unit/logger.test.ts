import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLogger,
  setLogLevel,
  addLogListener,
  getLogBuffer,
  clearLogBuffer,
} from "../../src/lib/logger";

describe("logger", () => {
  beforeEach(() => {
    setLogLevel("debug");
    vi.restoreAllMocks();
  });

  it("logs to console at each level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = createLogger("test");
    log.debug("debug msg");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("respects log level filtering", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setLogLevel("warn");
    const log = createLogger("test");
    log.debug("should not appear");
    log.warn("should appear");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("includes component name in output", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = createLogger("MyComponent");
    log.info("hello");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const firstArg = infoSpy.mock.calls[0]?.[0] as string;
    expect(firstArg).toContain("[MyComponent]");
  });

  it("includes data parameter when provided", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = createLogger("test");
    log.info("with data", { key: "value" });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      "with data",
      { key: "value" },
    );
  });

  it("notifies listeners", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = addLogListener(listener);

    const log = createLogger("test");
    log.info("hello");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      level: "info",
      component: "test",
      message: "hello",
    });

    unsubscribe();
    log.info("after unsubscribe");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes listener", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = addLogListener(listener);

    unsubscribe();

    const log = createLogger("test");
    log.warn("should not reach listener");
    expect(listener).not.toHaveBeenCalled();
  });

  it("serializes Error objects in data parameter", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    const unsub = addLogListener(listener);

    const log = createLogger("test");
    const err = new Error("something broke");
    log.error("fail", err);

    expect(listener).toHaveBeenCalledTimes(1);
    const entry = listener.mock.calls[0]?.[0];
    expect(entry.data).toEqual(
      expect.objectContaining({ error: "something broke" }),
    );
    expect(entry.data).toHaveProperty("stack");

    unsub();
  });

  it("serializes nested Error objects within data objects", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = vi.fn();
    const unsub = addLogListener(listener);

    const log = createLogger("test");
    const err = new Error("inner error");
    log.warn("context", { reason: err, count: 3 });

    const entry = listener.mock.calls[0]?.[0];
    expect(entry.data.reason).toEqual(
      expect.objectContaining({ error: "inner error" }),
    );
    expect(entry.data.count).toBe(3);

    unsub();
  });

  it("getLogBuffer returns stored entries", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    clearLogBuffer();

    const log = createLogger("buf");
    log.info("entry one");
    log.info("entry two");

    const buffer = getLogBuffer();
    expect(buffer.length).toBe(2);
    expect(buffer[0]!.message).toBe("entry one");
    expect(buffer[1]!.message).toBe("entry two");
  });

  it("clearLogBuffer empties the buffer", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createLogger("buf");
    log.info("something");
    expect(getLogBuffer().length).toBeGreaterThan(0);

    clearLogBuffer();
    expect(getLogBuffer().length).toBe(0);
  });

  it("passes empty string instead of undefined when no data", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = createLogger("test");
    log.info("no data");

    // The third argument should be "" (empty string fallback)
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      "no data",
      "",
    );
  });
});
