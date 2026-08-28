import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Disposable } from "../../src/lib/disposable";

describe("Disposable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── addCleanup ─────────────────────────────────────────

  describe("addCleanup", () => {
    it("calls cleanup function on destroy", () => {
      const d = new Disposable();
      const fn = vi.fn();
      d.addCleanup(fn);
      expect(fn).not.toHaveBeenCalled();
      d.destroy();
      expect(fn).toHaveBeenCalledOnce();
    });

    it("runs cleanup immediately if already destroyed", () => {
      const d = new Disposable();
      d.destroy();
      const fn = vi.fn();
      d.addCleanup(fn);
      expect(fn).toHaveBeenCalledOnce();
    });

    it("handles multiple cleanup functions in order", () => {
      const d = new Disposable();
      const order: number[] = [];
      d.addCleanup(() => order.push(1));
      d.addCleanup(() => order.push(2));
      d.addCleanup(() => order.push(3));
      d.destroy();
      expect(order).toEqual([1, 2, 3]);
    });
  });

  // ── onStoreChange ──────────────────────────────────────

  describe("onStoreChange", () => {
    it("subscribes to store and cleans up on destroy", () => {
      const unsubscribe = vi.fn();
      const mockStore = {
        subscribeSelector: vi.fn(() => unsubscribe),
      };
      const selector = (s: unknown) => s;
      const callback = vi.fn();

      const d = new Disposable();
      d.onStoreChange(mockStore, selector, callback);

      expect(mockStore.subscribeSelector).toHaveBeenCalledWith(selector, callback);
      expect(unsubscribe).not.toHaveBeenCalled();

      d.destroy();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  // ── onEvent ────────────────────────────────────────────

  describe("onEvent", () => {
    it("attaches event listener with AbortController signal", () => {
      const d = new Disposable();
      const target = document.createElement("div");
      const handler = vi.fn();

      d.onEvent(target, "click", handler);

      // Listener should fire before destroy
      target.dispatchEvent(new Event("click"));
      expect(handler).toHaveBeenCalledOnce();

      // After destroy, signal is aborted and listener is removed
      d.destroy();
      target.dispatchEvent(new Event("click"));
      expect(handler).toHaveBeenCalledOnce(); // still 1, not 2
    });

    it("passes additional options through to addEventListener", () => {
      const d = new Disposable();
      const target = document.createElement("div");
      const addSpy = vi.spyOn(target, "addEventListener");
      const handler = vi.fn();

      d.onEvent(target, "click", handler, { capture: true });

      expect(addSpy).toHaveBeenCalledWith(
        "click",
        expect.any(Function),
        expect.objectContaining({ capture: true, signal: d.signal }),
      );

      d.destroy();
    });
  });

  // ── onInterval ─────────────────────────────────────────

  describe("onInterval", () => {
    it("registers an interval that fires on schedule", () => {
      const d = new Disposable();
      const fn = vi.fn();
      d.onInterval(fn, 1000);

      vi.advanceTimersByTime(3000);
      expect(fn).toHaveBeenCalledTimes(3);

      d.destroy();
    });

    it("clears interval on destroy", () => {
      const d = new Disposable();
      const fn = vi.fn();
      d.onInterval(fn, 1000);

      vi.advanceTimersByTime(2000);
      expect(fn).toHaveBeenCalledTimes(2);

      d.destroy();

      vi.advanceTimersByTime(5000);
      expect(fn).toHaveBeenCalledTimes(2); // no further calls
    });
  });

  // ── destroy ────────────────────────────────────────────

  describe("destroy", () => {
    it("is idempotent — second call is a no-op", () => {
      const d = new Disposable();
      const fn = vi.fn();
      d.addCleanup(fn);
      d.destroy();
      d.destroy();
      expect(fn).toHaveBeenCalledOnce();
    });

    it("aborts the AbortController signal", () => {
      const d = new Disposable();
      expect(d.signal.aborted).toBe(false);
      d.destroy();
      expect(d.signal.aborted).toBe(true);
    });

    it("clears the internal cleanup array", () => {
      const d = new Disposable();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      d.addCleanup(fn1);
      d.addCleanup(fn2);
      d.destroy();

      // After destroy, adding a new cleanup runs it immediately (not deferred)
      const fn3 = vi.fn();
      d.addCleanup(fn3);
      expect(fn3).toHaveBeenCalledOnce();
    });

    it("prevents further addCleanup from deferring", () => {
      const d = new Disposable();
      d.destroy();

      const lateCleanup = vi.fn();
      d.addCleanup(lateCleanup);
      // Should have run immediately, not queued
      expect(lateCleanup).toHaveBeenCalledOnce();
    });
  });

  // ── signal ─────────────────────────────────────────────

  describe("signal", () => {
    it("is exposed and not aborted initially", () => {
      const d = new Disposable();
      expect(d.signal).toBeInstanceOf(AbortSignal);
      expect(d.signal.aborted).toBe(false);
      d.destroy();
    });

    it("is aborted after destroy", () => {
      const d = new Disposable();
      const sig = d.signal;
      d.destroy();
      expect(sig.aborted).toBe(true);
    });
  });
});
