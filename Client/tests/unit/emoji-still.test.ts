import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("blob:animated")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

import { buildCustomEmojiImage } from "../../src/components/message-list/custom-emoji";
import { clearAttachmentCaches } from "../../src/components/message-list/attachments";
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

  it("captureStill gives null for an image with no size or no 2d context", () => {
    const img = document.createElement("img");
    expect(captureStill(img)).toBeNull();
    loaded(img);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(captureStill(img)).toBeNull();
  });
});
