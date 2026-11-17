import { describe, expect, it, vi } from "vitest";
import { isVideoOnScreen, onVideoOnScreenChange, reportVideoOnScreen } from "./videoOnScreen";

describe("video on screen", () => {
  it("holds while any grid draws a picture, and tells a listener each change once", async () => {
    const seen = vi.fn();
    const stop = onVideoOnScreenChange(seen);
    expect(isVideoOnScreen()).toBe(false);

    reportVideoOnScreen(true);
    reportVideoOnScreen(true);
    await Promise.resolve();
    expect(isVideoOnScreen()).toBe(true);

    // One of the two grids stops: the other still draws.
    reportVideoOnScreen(false);
    await Promise.resolve();
    expect(isVideoOnScreen()).toBe(true);

    reportVideoOnScreen(false);
    await Promise.resolve();
    expect(isVideoOnScreen()).toBe(false);
    expect(seen.mock.calls).toEqual([[true], [false]]);

    stop();
    reportVideoOnScreen(true);
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(2);
    reportVideoOnScreen(false);
  });

  it("never counts below none: a stop with nothing drawn changes nothing", async () => {
    reportVideoOnScreen(false);
    reportVideoOnScreen(true);
    await Promise.resolve();
    expect(isVideoOnScreen()).toBe(true);
    reportVideoOnScreen(false);
    expect(isVideoOnScreen()).toBe(false);
  });
});
