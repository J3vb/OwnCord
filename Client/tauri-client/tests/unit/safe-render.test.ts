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
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("registers window error and unhandledrejection listeners", () => {
    const addEventSpy = vi.spyOn(window, "addEventListener");

    installGlobalErrorHandlers();

    const eventTypes = addEventSpy.mock.calls.map((call) => call[0]);
    expect(eventTypes).toContain("error");
    expect(eventTypes).toContain("unhandledrejection");
  });
});
