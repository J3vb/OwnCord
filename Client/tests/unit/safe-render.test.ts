import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  safeMount,
  renderFallback,
  installGlobalErrorHandlers,
  type MountableComponent,
} from "../../src/lib/text/safeRender";
import { addLogListener, setLogLevel, type LogEntry } from "../../src/lib/logger";
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

type Handler = (event: unknown) => void;

/** Run `install` while capturing the window listeners it registers. */
function captureWindowHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, handler: unknown) => {
    handlers.set(type, handler as Handler);
  });
  installGlobalErrorHandlers();
  return handlers;
}

/** The log lines written while `run` executes. */
function logged(run: () => void): LogEntry[] {
  const entries: LogEntry[] = [];
  const stop = addLogListener((entry) => entries.push(entry));
  try {
    run();
  } finally {
    stop();
  }
  return entries;
}

describe("global error handler log lines", () => {
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    handlers = captureWindowHandlers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("announces that the handlers are installed", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const entries = logged(() => installGlobalErrorHandlers());
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ["info", "Global error handlers installed"],
    ]);
  });

  it("logs an uncaught error with where it happened and the error's stack", () => {
    const err = new Error("boom");
    const entries = logged(() =>
      handlers.get("error")!({
        message: "Uncaught Error: boom",
        filename: "app.js",
        lineno: 42,
        colno: 10,
        error: err,
      }),
    );
    expectConsole("error", "Uncaught error");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.message).toBe("Uncaught error");
    expect(entries[0]!.data).toEqual({
      message: "Uncaught Error: boom",
      filename: "app.js",
      lineno: 42,
      colno: 10,
      error: err.stack,
    });
  });

  it("logs a thrown non-error as its string form", () => {
    const entries = logged(() =>
      handlers.get("error")!({ message: "m", filename: "f", lineno: 1, colno: 2, error: 404 }),
    );
    expectConsole("error", "Uncaught error");
    expect(entries[0]!.data).toMatchObject({ error: "404" });
  });

  it("logs a rejection with an error reason as its stack", () => {
    const err = new Error("rejected");
    const entries = logged(() => handlers.get("unhandledrejection")!({ reason: err }));
    expectConsole("error", "Unhandled promise rejection");
    expect(entries[0]).toMatchObject({ level: "error", message: "Unhandled promise rejection" });
    expect(entries[0]!.data).toEqual({ reason: err.stack });
  });

  it("logs the message of a rejected error that has no stack", () => {
    const err = new Error("no stack here");
    Object.defineProperty(err, "stack", { value: undefined });
    const entries = logged(() => handlers.get("unhandledrejection")!({ reason: err }));
    expectConsole("error", "Unhandled promise rejection");
    expect(entries[0]!.data).toEqual({ reason: "no stack here" });
  });

  it("logs other rejection reasons as strings", () => {
    const entries = logged(() => {
      handlers.get("unhandledrejection")!({ reason: "plain" });
      handlers.get("unhandledrejection")!({ reason: undefined });
      handlers.get("unhandledrejection")!({ reason: { code: 7 } });
    });
    expectConsole("error", "Unhandled promise rejection");
    expectConsole("error", "Unhandled promise rejection");
    expectConsole("error", "Unhandled promise rejection");
    expect(entries.map((e) => (e.data as { reason: string }).reason)).toEqual([
      "plain",
      "undefined",
      "[object Object]",
    ]);
  });

  it("downgrades a freed Tauri resource to one debug line without the error level", () => {
    const entries = logged(() =>
      handlers.get("unhandledrejection")!({ reason: "resource id 12 is invalid" }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "debug",
      message: "Tauri resource already freed (benign)",
    });
    expect(entries[0]!.data).toEqual({ reason: "resource id 12 is invalid" });
  });

  it("recognises a freed resource inside an error's stack or a longer message", () => {
    const err = new Error("Failed: resource id 99 is invalid (dropped)");
    const entries = logged(() => {
      handlers.get("unhandledrejection")!({ reason: err });
      handlers.get("unhandledrejection")!({ reason: "x resource id a is invalid y" });
    });
    expect(entries.map((e) => e.level)).toEqual(["debug", "debug"]);
  });

  it("still reports a rejection that only resembles the freed-resource text", () => {
    const entries = logged(() => {
      handlers.get("unhandledrejection")!({ reason: "resource id  is invalid" });
      handlers.get("unhandledrejection")!({ reason: "resource id 5 is valid" });
      handlers.get("unhandledrejection")!({ reason: "resource 5 is invalid" });
    });
    expectConsole("error", "Unhandled promise rejection");
    expectConsole("error", "Unhandled promise rejection");
    expectConsole("error", "Unhandled promise rejection");
    expect(entries.map((e) => e.level)).toEqual(["error", "error", "error"]);
  });
});

describe("fallback content", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the generic message in its own box and the error's message below it", () => {
    const container = document.createElement("div");
    renderFallback(container, new Error("chunk 7 failed"));
    expect(container.children).toHaveLength(1);
    const box = container.firstElementChild as HTMLElement;
    expect(box.tagName).toBe("DIV");
    expect(box.firstChild?.textContent).toBe("Something went wrong rendering this section.");
    const detail = box.querySelector("pre");
    expect(detail?.textContent).toBe("chunk 7 failed");
    expect(box.children).toHaveLength(1);
    expect(box.querySelector("button")).toBeNull();
  });

  it("shows no error detail for a value that is not an Error", () => {
    for (const thrown of ["text", 42, null, undefined, { message: "looks like one" }]) {
      const container = document.createElement("div");
      renderFallback(container, thrown);
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).toBe("Something went wrong rendering this section.");
    }
  });

  it("replaces whatever the container held, children included", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>old</p><span>stuff</span>";
    renderFallback(container, null);
    expect(container.querySelector("p, span")).toBeNull();
    expect(container.children).toHaveLength(1);
    renderFallback(container, null);
    expect(container.children).toHaveLength(1);
  });

  it("puts the recovery buttons in one row, Reload before Sign out", () => {
    const container = document.createElement("div");
    renderFallback(container, new Error("x"), { reload: vi.fn(), signOut: vi.fn() });
    const row = container.querySelector("button")!.parentElement!;
    expect(row.tagName).toBe("DIV");
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map((b) => b.dataset.testid)).toEqual([
      "render-fallback-reload",
      "render-fallback-sign-out",
    ]);
    expect(buttons.map((b) => b.type)).toEqual(["button", "button"]);
    expect(buttons.map((b) => b.textContent)).toEqual(["Reload", "Sign out"]);
    expect(row.parentElement).toBe(container.firstElementChild);
    expect(row.parentElement!.lastElementChild).toBe(row);
  });

  it("mounts into the container it was given and leaves a good mount alone", () => {
    const container = document.createElement("div");
    container.append("kept");
    const mount = vi.fn();
    const destroy = vi.fn();
    safeMount({ mount, destroy }, container);
    expect(mount).toHaveBeenCalledWith(container);
    expect(destroy).not.toHaveBeenCalled();
    expect(container.textContent).toBe("kept");
  });

  it("replaces a half-built mount with the fallback and logs the error", () => {
    const container = document.createElement("div");
    const err = new Error("half way");
    const entries = logged(() =>
      safeMount(
        {
          mount(el) {
            el.append("partial");
            throw err;
          },
        },
        container,
      ),
    );
    expectConsole("error", "Component mount failed");
    expect(container.textContent).not.toContain("partial");
    expect(container.querySelector("pre")?.textContent).toBe("half way");
    const failure = entries.find((e) => e.message === "Component mount failed");
    expect(failure?.level).toBe("error");
    expect(failure?.data).toMatchObject({ error: "half way" });
  });
});

function clickBoth(reload: () => void | Promise<void>, signOut: () => void): LogEntry[] {
  const container = document.createElement("div");
  renderFallback(container, null, { reload, signOut });
  return logged(() => {
    container.querySelector<HTMLButtonElement>('[data-testid="render-fallback-reload"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-testid="render-fallback-sign-out"]')!.click();
  });
}

describe("recovery action outcomes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nothing when both actions succeed, whether or not reload is async", async () => {
    expect(clickBoth(() => {}, vi.fn())).toEqual([]);
    expect(clickBoth(() => Promise.resolve(), vi.fn())).toEqual([]);
    await Promise.resolve();
  });

  it("logs a rejected async reload as a failed recovery action", async () => {
    const entries: LogEntry[] = [];
    const stop = addLogListener((entry) => entries.push(entry));
    try {
      const container = document.createElement("div");
      renderFallback(container, null, {
        reload: () => Promise.reject(new Error("reload refused")),
        signOut: vi.fn(),
      });
      container.querySelector<HTMLButtonElement>('[data-testid="render-fallback-reload"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      stop();
    }
    expectConsole("error", "Recovery action failed");
    expect(entries.map((e) => [e.level, e.message])).toEqual([["error", "Recovery action failed"]]);
    expect(entries[0]!.data).toMatchObject({ error: "reload refused" });
  });

  it("logs a throwing sign out and still ran reload", () => {
    const reload = vi.fn();
    const entries = clickBoth(reload, () => {
      throw new Error("sign out blocked");
    });
    expectConsole("error", "Recovery action failed");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => [e.level, e.message])).toEqual([["error", "Recovery action failed"]]);
    expect(entries[0]!.data).toMatchObject({ error: "sign out blocked" });
  });
});

describe("fallback styling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("styles the box, the error detail, the button row and the buttons", () => {
    const container = document.createElement("div");
    renderFallback(container, new Error("detail"), { reload: vi.fn(), signOut: vi.fn() });
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.padding).toBe("16px");
    expect(box.style.borderRadius).toBe("8px");
    expect(box.style.fontSize).toBe("13px");
    expect(box.style.margin).toBe("8px");
    expect(box.style.color).not.toBe("");
    expect(box.style.backgroundColor).not.toBe("");

    const detail = box.querySelector("pre")!;
    expect(detail.style.fontSize).toBe("11px");
    expect(detail.style.marginTop).toBe("8px");
    expect(detail.style.whiteSpace).toBe("pre-wrap");
    expect(detail.style.color).not.toBe("");

    const row = box.querySelector("button")!.parentElement!;
    expect(row.style.display).toBe("flex");
    expect(row.style.marginTop).toBe("12px");
    expect(row.style.cssText).toContain("8px");

    for (const button of row.querySelectorAll("button")) {
      expect(button.style.padding).toBe("6px 14px");
      expect(button.style.cursor).toBe("pointer");
      expect(button.style.borderRadius).toBe("4px");
      expect(button.style.fontSize).toBe("13px");
      expect(button.style.backgroundColor).not.toBe("");
    }
  });
});
