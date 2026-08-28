import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  setLogLevel,
  getLogLevel,
  applyStoredLogLevel,
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

    expect(infoSpy).toHaveBeenCalledWith(expect.any(String), "with data", { key: "value" });
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
    expect(entry.data).toEqual(expect.objectContaining({ error: "something broke" }));
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
    expect(entry.data.reason).toEqual(expect.objectContaining({ error: "inner error" }));
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

  it("getLogLevel reflects the current effective level", () => {
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    setLogLevel("error");
    expect(getLogLevel()).toBe("error");
  });

  it("getLogLevel reflects the applyStoredLogLevel fallback when no pref is stored", () => {
    localStorage.clear();
    applyStoredLogLevel("info");
    expect(getLogLevel()).toBe("info");
  });

  it("passes empty string instead of undefined when no data", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = createLogger("test");
    log.info("no data");

    // The third argument should be "" (empty string fallback)
    expect(infoSpy).toHaveBeenCalledWith(expect.any(String), "no data", "");
  });
});

describe("applyStoredLogLevel", () => {
  beforeEach(() => {
    localStorage.clear();
    setLogLevel("debug");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    setLogLevel("debug");
  });

  it("falls back to the given default when no pref is stored", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    applyStoredLogLevel("info");
    const log = createLogger("test");
    log.debug("filtered");
    log.info("kept");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("honors the saved logs_min_level pref over the fallback", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("owncord:settings:logs_min_level", JSON.stringify("error"));

    applyStoredLogLevel("debug");
    const log = createLogger("test");
    log.warn("filtered");
    log.error("kept");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("migrates a legacy unprefixed logs_min_level key and honors it", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Legacy values were stored raw under the unprefixed key.
    localStorage.setItem("logs_min_level", "warn");

    applyStoredLogLevel("debug");
    const log = createLogger("test");
    log.info("filtered");
    log.warn("kept");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The legacy value is migrated forward to the prefixed key.
    expect(localStorage.getItem("owncord:settings:logs_min_level")).toBe('"warn"');
  });

  it("ignores invalid stored values and uses the fallback", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    localStorage.setItem("owncord:settings:logs_min_level", JSON.stringify("verbose"));

    applyStoredLogLevel("warn");
    const log = createLogger("test");
    log.info("filtered");

    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("log level pref-change live updates", () => {
  beforeEach(() => {
    localStorage.clear();
    setLogLevel("debug");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    setLogLevel("debug");
  });

  it("applies a new logs_min_level when owncord:pref-change fires", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("owncord:settings:logs_min_level", JSON.stringify("error"));

    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "logs_min_level" } }),
    );

    const log = createLogger("test");
    log.debug("filtered");
    log.error("kept");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores pref-change events for other keys", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    localStorage.setItem("owncord:settings:logs_min_level", JSON.stringify("error"));

    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "compactMode" } }),
    );

    const log = createLogger("test");
    log.debug("kept — level unchanged");

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the current level when the pref is cleared", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    setLogLevel("info");

    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "logs_min_level" } }),
    );

    const log = createLogger("test");
    log.info("kept");

    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});
