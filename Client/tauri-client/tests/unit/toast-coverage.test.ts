import { describe, it, expect, vi, beforeEach } from "vitest";
import { initToast, teardownToast, showToast } from "../../src/lib/toast";
import type { ToastContainer } from "../../src/components/Toast";

/**
 * Tests for src/lib/toast.ts — global toast helper.
 * Covers initToast, teardownToast, and showToast forwarding behavior.
 */

function createMockContainer(): ToastContainer {
  return {
    mount: vi.fn(),
    destroy: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
  };
}

describe("toast global helper", () => {
  beforeEach(() => {
    // Reset module state between tests
    teardownToast();
  });

  // ── initToast ────────────────────────────────────────────

  describe("initToast", () => {
    it("registers a ToastContainer instance", () => {
      const container = createMockContainer();
      initToast(container);

      // After init, showToast should forward to the container
      showToast("hello");
      expect(container.show).toHaveBeenCalledOnce();
    });

    it("replaces a previously registered container on subsequent calls", () => {
      const first = createMockContainer();
      const second = createMockContainer();

      initToast(first);
      initToast(second);

      showToast("message");
      expect(first.show).not.toHaveBeenCalled();
      expect(second.show).toHaveBeenCalledOnce();
    });
  });

  // ── teardownToast ────────────────────────────────────────

  describe("teardownToast", () => {
    it("clears the registered instance so showToast becomes a no-op", () => {
      const container = createMockContainer();
      initToast(container);
      teardownToast();

      showToast("should not appear");
      expect(container.show).not.toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      const container = createMockContainer();
      initToast(container);
      teardownToast();
      teardownToast();

      showToast("noop");
      expect(container.show).not.toHaveBeenCalled();
    });
  });

  // ── showToast ────────────────────────────────────────────

  describe("showToast", () => {
    it("forwards message and type to the registered container", () => {
      const container = createMockContainer();
      initToast(container);

      showToast("Server connected", "success");
      expect(container.show).toHaveBeenCalledWith("Server connected", "success", undefined);
    });

    it("defaults the type to 'info' when not specified", () => {
      const container = createMockContainer();
      initToast(container);

      showToast("Some info");
      expect(container.show).toHaveBeenCalledWith("Some info", "info", undefined);
    });

    it("passes through a custom durationMs", () => {
      const container = createMockContainer();
      initToast(container);

      showToast("Quick toast", "error", 2000);
      expect(container.show).toHaveBeenCalledWith("Quick toast", "error", 2000);
    });

    it("no-ops after teardownToast has been called", () => {
      const container = createMockContainer();
      initToast(container);
      teardownToast();

      expect(() => showToast("after teardown")).not.toThrow();
      expect(container.show).not.toHaveBeenCalled();
    });

    it("handles all three toast types", () => {
      const container = createMockContainer();
      initToast(container);

      showToast("info msg", "info");
      showToast("error msg", "error");
      showToast("success msg", "success");

      expect(container.show).toHaveBeenCalledTimes(3);
      expect(container.show).toHaveBeenNthCalledWith(1, "info msg", "info", undefined);
      expect(container.show).toHaveBeenNthCalledWith(2, "error msg", "error", undefined);
      expect(container.show).toHaveBeenNthCalledWith(3, "success msg", "success", undefined);
    });
  });
});
