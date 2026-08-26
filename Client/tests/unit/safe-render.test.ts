import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  safeMount,
  installGlobalErrorHandlers,
  type MountableComponent,
} from "../../src/lib/safe-render";

describe("safeMount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("mounts a working component", () => {
    const container = document.createElement("div");
    const component: MountableComponent = {
      mount(el: Element) {
        el.textContent = "Hello";
      },
    };

    safeMount(component, container);
    expect(container.textContent).toBe("Hello");
  });

  it("shows fallback UI when component throws", () => {
    const container = document.createElement("div");
    const component: MountableComponent = {
      mount() {
        throw new Error("Render failed");
      },
    };

    safeMount(component, container);
    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("Render failed");
  });

  it("shows fallback without error details for non-Error throws", () => {
    const container = document.createElement("div");
    const component: MountableComponent = {
      mount() {
        throw "string error";
      },
    };

    safeMount(component, container);
    expect(container.textContent).toContain("Something went wrong");
  });

  it("clears container before showing fallback", () => {
    const container = document.createElement("div");
    container.textContent = "existing content";

    const component: MountableComponent = {
      mount() {
        throw new Error("fail");
      },
    };

    safeMount(component, container);
    expect(container.textContent).not.toContain("existing content");
  });
});

describe("installGlobalErrorHandlers", () => {
  let errorHandlers: Map<string, Function>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});

    // Capture the handlers registered by installGlobalErrorHandlers
    errorHandlers = new Map();
    vi.spyOn(window, "addEventListener").mockImplementation((type: string, handler: any) => {
      errorHandlers.set(type, handler);
    });

    installGlobalErrorHandlers();
  });

  it("registers window error and unhandledrejection listeners", () => {
    expect(errorHandlers.has("error")).toBe(true);
    expect(errorHandlers.has("unhandledrejection")).toBe(true);
  });

  it("error handler logs Error objects with stack trace", () => {
    const errorSpy = vi.spyOn(console, "error");
    const testError = new Error("test uncaught");
    const handler = errorHandlers.get("error")!;
    handler({
      message: "Uncaught Error: test uncaught",
      filename: "app.js",
      lineno: 42,
      colno: 10,
      error: testError,
    });

    expect(errorSpy).toHaveBeenCalled();
  });

  it("error handler logs non-Error values as strings", () => {
    const errorSpy = vi.spyOn(console, "error");
    const handler = errorHandlers.get("error")!;
    handler({
      message: "Script error",
      filename: "",
      lineno: 0,
      colno: 0,
      error: "some string error",
    });

    expect(errorSpy).toHaveBeenCalled();
  });

  it("unhandledrejection handler logs Error reason", () => {
    const errorSpy = vi.spyOn(console, "error");
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: new Error("promise failed") });

    expect(errorSpy).toHaveBeenCalled();
  });

  it("unhandledrejection handler logs non-Error reason as string", () => {
    const errorSpy = vi.spyOn(console, "error");
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: "string rejection" });

    expect(errorSpy).toHaveBeenCalled();
  });

  it("unhandledrejection handler downgrades Tauri resource cleanup to debug", () => {
    const errorSpy = vi.spyOn(console, "error");
    const debugSpy = vi.spyOn(console, "debug");
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: "resource id abc123 is invalid" });

    // Should NOT log as error — it's benign
    // The error spy may have been called during setup; check the last call is not from this
    const errorCallCount = errorSpy.mock.calls.length;
    handler({ reason: "resource id xyz789 is invalid" });
    expect(errorSpy.mock.calls.length).toBe(errorCallCount);
    expect(debugSpy).toHaveBeenCalled();
  });

  it("unhandledrejection handler uses Error stack when available", () => {
    const errorSpy = vi.spyOn(console, "error");
    const err = new Error("with stack");
    // Error objects always have stack in V8, just verify no crash
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: err });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("unhandledrejection handler falls back to message when no stack", () => {
    const errorSpy = vi.spyOn(console, "error");
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: err });
    expect(errorSpy).toHaveBeenCalled();
  });
});
