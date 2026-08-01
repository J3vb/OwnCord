import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isNsfwAcknowledged,
  acknowledgeNsfw,
  clearNsfwAcknowledgements,
  nsfwGateRequired,
} from "@lib/nsfw-gate";
import { createNsfwGate } from "@components/NsfwGate";

describe("nsfw-gate acknowledgements", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("reports an un-acknowledged channel as not acknowledged", () => {
    expect(isNsfwAcknowledged(42)).toBe(false);
  });

  it("remembers an acknowledgement", () => {
    acknowledgeNsfw(42);
    expect(isNsfwAcknowledged(42)).toBe(true);
  });

  it("keys the acknowledgement per channel", () => {
    acknowledgeNsfw(42);
    expect(isNsfwAcknowledged(43)).toBe(false);
  });

  // The promise is "once per session", so it must live in sessionStorage —
  // localStorage would silently make it "once ever" and the flag would stop
  // meaning anything after the first visit.
  it("stores the acknowledgement in sessionStorage, not localStorage", () => {
    acknowledgeNsfw(7);
    expect(sessionStorage.length).toBeGreaterThan(0);
    expect(localStorage.getItem("owncord:nsfw-ack:7")).toBeNull();
  });

  it("clears every acknowledgement", () => {
    acknowledgeNsfw(1);
    acknowledgeNsfw(2);
    clearNsfwAcknowledgements();
    expect(isNsfwAcknowledged(1)).toBe(false);
    expect(isNsfwAcknowledged(2)).toBe(false);
  });

  it("leaves unrelated session keys alone when clearing", () => {
    sessionStorage.setItem("unrelated", "keep me");
    acknowledgeNsfw(1);
    clearNsfwAcknowledgements();
    expect(sessionStorage.getItem("unrelated")).toBe("keep me");
  });

  // A storage that throws must not hide the gate — erring toward asking again
  // is harmless, where erring the other way drops the whole feature.
  it("reads a throwing sessionStorage as not acknowledged", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(isNsfwAcknowledged(1)).toBe(false);
    spy.mockRestore();
  });

  it("does not throw when the acknowledgement cannot be stored", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => acknowledgeNsfw(1)).not.toThrow();
    spy.mockRestore();
  });

  describe("nsfwGateRequired", () => {
    it("is false for a channel that is not flagged", () => {
      expect(nsfwGateRequired({ id: 1, nsfw: false })).toBe(false);
    });

    it("is true for a flagged channel not yet acknowledged", () => {
      expect(nsfwGateRequired({ id: 1, nsfw: true })).toBe(true);
    });

    it("is false once the channel has been acknowledged this session", () => {
      acknowledgeNsfw(1);
      expect(nsfwGateRequired({ id: 1, nsfw: true })).toBe(false);
    });
  });
});

describe("NsfwGate component", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mountGate(overrides?: {
    onContinue?: () => void;
    onCancel?: () => void;
    channelId?: number;
  }) {
    const onContinue = overrides?.onContinue ?? vi.fn();
    const gate = createNsfwGate({
      channelId: overrides?.channelId ?? 9,
      channelName: "spicy",
      onContinue,
      ...(overrides?.onCancel !== undefined ? { onCancel: overrides.onCancel } : {}),
    });
    gate.mount(container);
    return { gate, onContinue };
  }

  it("renders the warning over the container", () => {
    const { gate } = mountGate();
    const el = container.querySelector("[data-testid='nsfw-gate']");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("This channel may contain sensitive content");
    gate.destroy?.();
  });

  it("names the channel it is gating", () => {
    const { gate } = mountGate();
    expect(container.querySelector(".nsfw-gate-title")?.textContent).toBe("#spicy");
    gate.destroy?.();
  });

  // The copy must not imply the server is filtering anything — it is not.
  it("says plainly that nothing is filtered", () => {
    const { gate } = mountGate();
    expect(container.querySelector("[data-testid='nsfw-gate']")?.textContent).toContain(
      "Nothing is filtered",
    );
    gate.destroy?.();
  });

  it("records the acknowledgement and notifies on Continue", () => {
    const onContinue = vi.fn();
    const { gate } = mountGate({ onContinue, channelId: 11 });

    (container.querySelector("[data-testid='nsfw-gate-continue']") as HTMLButtonElement).click();

    expect(isNsfwAcknowledged(11)).toBe(true);
    expect(onContinue).toHaveBeenCalledTimes(1);
    gate.destroy?.();
  });

  it("offers no Go Back button without an onCancel", () => {
    const { gate } = mountGate();
    expect(container.querySelector("[data-testid='nsfw-gate-back']")).toBeNull();
    gate.destroy?.();
  });

  it("calls onCancel from Go Back without acknowledging", () => {
    const onCancel = vi.fn();
    const { gate } = mountGate({ onCancel, channelId: 12 });

    (container.querySelector("[data-testid='nsfw-gate-back']") as HTMLButtonElement).click();

    expect(onCancel).toHaveBeenCalledTimes(1);
    // Declining must not be remembered as acceptance — the next open asks again.
    expect(isNsfwAcknowledged(12)).toBe(false);
    gate.destroy?.();
  });

  it("removes itself on destroy", () => {
    const { gate } = mountGate();
    gate.destroy?.();
    expect(container.querySelector("[data-testid='nsfw-gate']")).toBeNull();
  });

  it("stops responding to clicks after destroy", () => {
    const onContinue = vi.fn();
    const gate = createNsfwGate({ channelId: 3, channelName: "spicy", onContinue });
    gate.mount(container);
    const btn = container.querySelector("[data-testid='nsfw-gate-continue']") as HTMLButtonElement;
    gate.destroy?.();
    btn.click();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
