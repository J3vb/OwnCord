import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  safeMount,
  renderFallback,
  installGlobalErrorHandlers,
  type MountableComponent,
} from "../../src/lib/text/safeRender";
import { setLogLevel } from "../../src/lib/logger";
import { expectConsole } from "../helpers/console";

// The unhandledrejection test below asserts on the logger's debug line, so
// this file raises the level the global setup lowered (C-04) and puts it back
// afterwards.
beforeEach(() => {
  setLogLevel("debug");
});
afterEach(() => {
  setLogLevel("warn");
});

describe("safeMount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, "error");
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
    expectConsole("error", "Component mount failed");
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
    expectConsole("error", "Component mount failed");
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
    expectConsole("error", "Component mount failed");
  });
});

describe("installGlobalErrorHandlers", () => {
  let errorHandlers: Map<string, Function>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error");
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
    expectConsole("error", "Uncaught error");
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
    expectConsole("error", "Uncaught error");
  });

  it("unhandledrejection handler logs Error reason", () => {
    const errorSpy = vi.spyOn(console, "error");
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: new Error("promise failed") });

    expect(errorSpy).toHaveBeenCalled();
    expectConsole("error", "Unhandled promise rejection");
  });

  it("unhandledrejection handler logs non-Error reason as string", () => {
    const errorSpy = vi.spyOn(console, "error");
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: "string rejection" });

    expect(errorSpy).toHaveBeenCalled();
    expectConsole("error", "Unhandled promise rejection");
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
    expectConsole("error", "Unhandled promise rejection");
  });

  it("unhandledrejection handler falls back to message when no stack", () => {
    const errorSpy = vi.spyOn(console, "error");
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    const handler = errorHandlers.get("unhandledrejection")!;
    handler({ reason: err });
    expect(errorSpy).toHaveBeenCalled();
    expectConsole("error", "Unhandled promise rejection");
  });
});

describe("recovery buttons on the fallback", () => {
  beforeEach(() => {
    vi.spyOn(console, "error");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  const buttons = (container: Element) => ({
    reload: container.querySelector<HTMLButtonElement>('[data-testid="render-fallback-reload"]'),
    signOut: container.querySelector<HTMLButtonElement>('[data-testid="render-fallback-sign-out"]'),
  });

  it("shows Reload and Sign out when a mount throws, and each calls its callback", () => {
    const container = document.createElement("div");
    const recovery = { reload: vi.fn(), signOut: vi.fn() };
    safeMount(
      {
        mount() {
          throw new Error("Render failed");
        },
      },
      container,
      recovery,
    );
    expectConsole("error", "Component mount failed");

    const { reload, signOut } = buttons(container);
    expect(reload?.textContent).toBe("Reload");
    expect(signOut?.textContent).toBe("Sign out");

    reload!.click();
    expect(recovery.reload).toHaveBeenCalledTimes(1);
    expect(recovery.signOut).not.toHaveBeenCalled();
    signOut!.click();
    expect(recovery.signOut).toHaveBeenCalledTimes(1);
    expect(recovery.reload).toHaveBeenCalledTimes(1);
  });

  it("renders the same buttons for a failure outside a mount (a rejected page import)", () => {
    const container = document.createElement("div");
    container.textContent = "stale";
    const recovery = { reload: vi.fn(), signOut: vi.fn() };
    renderFallback(container, new Error("chunk failed"), recovery);

    expect(container.textContent).not.toContain("stale");
    expect(container.textContent).toContain("Something went wrong");
    const { reload, signOut } = buttons(container);
    reload!.click();
    signOut!.click();
    expect(recovery.reload).toHaveBeenCalledTimes(1);
    expect(recovery.signOut).toHaveBeenCalledTimes(1);
  });

  it("keeps working when a recovery action throws", () => {
    const container = document.createElement("div");
    renderFallback(container, null, {
      reload: () => {
        throw new Error("reload blocked");
      },
      signOut: vi.fn(),
    });
    expect(() => buttons(container).reload!.click()).not.toThrow();
    expectConsole("error", "Recovery action failed");
  });

  it("shows no buttons when the caller gives no recovery", () => {
    const container = document.createElement("div");
    safeMount(
      {
        mount() {
          throw new Error("x");
        },
      },
      container,
    );
    expectConsole("error", "Component mount failed");
    expect(container.querySelector("button")).toBeNull();
  });
});
