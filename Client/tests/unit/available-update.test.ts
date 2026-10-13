import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getAvailableUpdate,
  setAvailableUpdate,
  subscribeAvailableUpdate,
} from "../../src/features/updates/availableUpdate";

const OFFER = { version: "2.0.0", body: "- Notes", serverUrl: "https://s.example" };

describe("availableUpdate", () => {
  afterEach(() => setAvailableUpdate(null));

  it("replays the current offer on subscribe, then reports changes", () => {
    setAvailableUpdate(OFFER);
    const listener = vi.fn();
    const unsubscribe = subscribeAvailableUpdate(listener);
    expect(listener).toHaveBeenLastCalledWith(OFFER);
    setAvailableUpdate(null);
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(getAvailableUpdate()).toBeNull();
    unsubscribe();
    setAvailableUpdate(OFFER);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when the same offer arrives again", () => {
    const listener = vi.fn();
    subscribeAvailableUpdate(listener);
    setAvailableUpdate(OFFER);
    setAvailableUpdate({ ...OFFER });
    expect(listener).toHaveBeenCalledTimes(2);
    setAvailableUpdate({ ...OFFER, body: "- Other notes" });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
