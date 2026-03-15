import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLogger,
  setLogLevel,
  addLogListener,
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
});
