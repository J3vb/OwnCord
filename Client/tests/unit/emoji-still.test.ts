import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("blob:animated")),
}));
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

import { buildCustomEmojiImage } from "../../src/features/messaging/content/customEmoji";
import { clearAttachmentCaches } from "../../src/features/messaging/content/attachments";
import {
  animateEmojiEnabled,
  captureStill,
  clearStillCache,
  showStillFrame,
} from "../../src/features/messaging/emojiStill";

const EMOJI = { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" };
const STILL = "data:image/png;base64,STILL";

/** A loaded 32x32 image, as jsdom never loads one. */
function loaded(img: HTMLImageElement, w = 32, h = 32): void {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}

const still = (url: string): boolean => {
  const probe = document.createElement("img");
  showStillFrame(probe, url);
  return probe.getAttribute("src") === STILL;
};
const capture = (url: string): void => {
  const img = document.createElement("img");
  showStillFrame(img, url);
  loaded(img);
  img.dispatchEvent(new Event("load"));
};

describe("Animate emoji", () => {
  let drawImage: ReturnType<typeof vi.fn>;
  let toDataURL: Mock<(type?: string, quality?: number) => string>;

  beforeEach(() => {
    localStorage.clear();
    clearStillCache();
    fetchImageAsObjectUrlMock.mockClear();
    fetchImageAsObjectUrlMock.mockResolvedValue("blob:animated");
    drawImage = vi.fn();
    toDataURL = vi.fn<(type?: string, quality?: number) => string>(() => STILL);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(toDataURL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is on unless the pref says false, and ignores a wrong-typed value", () => {
    expect(animateEmojiEnabled()).toBe(true);
    localStorage.setItem("owncord:settings:animateEmoji", "false");
    expect(animateEmojiEnabled()).toBe(false);
    localStorage.setItem("owncord:settings:animateEmoji", '"abc"');
    expect(animateEmojiEnabled()).toBe(true);
  });

  it("on: the emoji gets the animated source as it is", async () => {
    const img = buildCustomEmojiImage(EMOJI);
    await vi.waitFor(() => expect(img.getAttribute("src")).toBe("blob:animated"));
    loaded(img);
    img.dispatchEvent(new Event("load"));
    expect(img.getAttribute("src")).toBe("blob:animated");
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("off: the emoji renders its first frame once the image has loaded", async () => {
    localStorage.setItem("owncord:settings:animateEmoji", "false");
    const img = buildCustomEmojiImage(EMOJI);
    await vi.waitFor(() => expect(img.getAttribute("src")).toBe("blob:animated"));
    loaded(img);
    img.dispatchEvent(new Event("load"));
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(img.getAttribute("src")).toBe(STILL);
    // The still's own load must not capture again.
    img.dispatchEvent(new Event("load"));
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("off: the same emoji source is captured once and reused", () => {
    const first = document.createElement("img");
    showStillFrame(first, "blob:animated");
    loaded(first);
    first.dispatchEvent(new Event("load"));
    const second = document.createElement("img");
    showStillFrame(second, "blob:animated");
    expect(second.getAttribute("src")).toBe(STILL);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("off: clearing the image caches drops the captured frames too", () => {
    const first = document.createElement("img");
    showStillFrame(first, "blob:animated");
    loaded(first);
    first.dispatchEvent(new Event("load"));
    clearAttachmentCaches();
    const second = document.createElement("img");
    showStillFrame(second, "blob:animated");
    expect(second.getAttribute("src")).not.toBe(STILL);
  });

  it("off: a frame that cannot be captured leaves the loaded emoji showing", () => {
    toDataURL.mockImplementation(() => {
      throw new Error("tainted");
    });
    const img = document.createElement("img");
    showStillFrame(img, "blob:animated");
    loaded(img);
    img.dispatchEvent(new Event("load"));
    expect(img.getAttribute("src")).toBe("blob:animated");
  });

  it("captureStill gives null when only one side has no size", () => {
    for (const [w, h] of [
      [0, 32],
      [32, 0],
    ] as const) {
      const img = document.createElement("img");
      loaded(img, w, h);
      expect(captureStill(img)).toBeNull();
    }
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("captureStill draws the whole image and encodes it as a PNG", () => {
    const img = document.createElement("img");
    loaded(img, 48, 20);
    expect(captureStill(img)).toBe(STILL);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(img, 0, 0, 48, 20);
    expect(toDataURL).toHaveBeenCalledExactlyOnceWith("image/png");
  });

  it("off: a frame equal to the current source is not remembered", () => {
    toDataURL.mockImplementation(() => "blob:animated");
    const first = document.createElement("img");
    showStillFrame(first, "blob:animated");
    loaded(first);
    first.dispatchEvent(new Event("load"));
    expect(drawImage).toHaveBeenCalledTimes(1);
    const second = document.createElement("img");
    showStillFrame(second, "blob:animated");
    loaded(second);
    second.dispatchEvent(new Event("load"));
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  describe("the captured frames are bounded", () => {
    it("keeps 256 frames and then forgets the oldest first", () => {
      for (let i = 0; i < 256; i++) capture(`blob:e${i}`);
      expect(still("blob:e0")).toBe(true);
      expect(still("blob:e255")).toBe(true);
      capture("blob:e256");
      expect(still("blob:e0")).toBe(false);
      expect(still("blob:e1")).toBe(true);
      expect(still("blob:e256")).toBe(true);
    });

    // Edge case: two emoji with one source finish loading one after the other.
    it("counts a frame captured twice as the newest, not the oldest", () => {
      const a = document.createElement("img");
      const b = document.createElement("img");
      showStillFrame(a, "blob:e0");
      showStillFrame(b, "blob:e0");
      loaded(a);
      a.dispatchEvent(new Event("load"));
      for (let i = 1; i < 256; i++) capture(`blob:e${i}`);
      loaded(b);
      b.dispatchEvent(new Event("load"));
      capture("blob:e256");
      expect(still("blob:e0")).toBe(true);
      expect(still("blob:e1")).toBe(false);
    });
  });

  it("captureStill gives null for an image with no size or no 2d context", () => {
    const img = document.createElement("img");
    expect(captureStill(img)).toBeNull();
    loaded(img);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(captureStill(img)).toBeNull();
  });
});
