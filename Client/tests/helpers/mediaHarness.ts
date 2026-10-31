import { afterEach, beforeEach, expect, vi } from "vitest";
import { closeActiveLightbox, clearMediaCaches } from "../../src/features/messaging/content/media";
import { clearExternalImageCache } from "../../src/features/messaging/content/attachments";
import { previewMock, imageMock, observeMediaMock, loadPrefMock } from "./mediaMocks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function oembedResponse(title: string | null) {
  return { ok: true, value: { title, description: null, siteName: null, image: null } };
}

export function oembedFail(failure = "unavailable") {
  return { ok: false, failure };
}

export function imageResponse(type = "image/png") {
  return { ok: true, value: new Blob(["x"], { type }) };
}

export let blobCounter = 0;

export const createObjectURLMock = vi.fn(() => `blob:owncord/${++blobCounter}`);

export const revokeObjectURLMock = vi.fn();

/** Wait until the broker has answered and the <img> inside `parent` has its
 *  blob: src; returns that src. */
export async function awaitImgSrc(parent: HTMLElement): Promise<string> {
  const img = parent.querySelector("img") as HTMLImageElement;
  await vi.waitFor(() => {
    expect(img.getAttribute("src")).toMatch(/^blob:/);
  });
  return img.getAttribute("src")!;
}

/**
 * media.ts caches showEmbeds/inlineMedia/showLinkPreviews/animateGifs at
 * module level and re-reads them on "owncord:pref-change" (the event savePref
 * dispatches). After changing loadPrefMock, dispatch those events so the
 * module's cached values pick up the new mock implementation.
 */
export function syncPrefCache(): void {
  for (const key of ["showEmbeds", "inlineMedia", "showLinkPreviews", "animateGifs"]) {
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key } }));
  }
}

/** Simulate image load event on the first <img> found inside an element. */
export function fireImgLoad(parent: HTMLElement): void {
  const img = parent.querySelector("img") as HTMLImageElement | null;
  if (img === null) throw new Error("No <img> found");
  img.dispatchEvent(new Event("load"));
}

/** Simulate image error event on the first <img> found inside an element. */
export function fireImgError(parent: HTMLElement): void {
  const img = parent.querySelector("img") as HTMLImageElement | null;
  if (img === null) throw new Error("No <img> found");
  img.dispatchEvent(new Event("error"));
}

/** Registers the shared beforeEach/afterEach for every media test file. */
export function useMediaHarness(): void {
  beforeEach(() => {
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = revokeObjectURLMock;
    // Before the mock resets: clearing names a fresh broker partition through
    // preview(), which must not count against the oEmbed call assertions.
    clearExternalImageCache();
    previewMock.mockReset();
    previewMock.mockResolvedValue(oembedFail());
    imageMock.mockReset();
    imageMock.mockResolvedValue(imageResponse());
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    observeMediaMock.mockReset();
    loadPrefMock.mockReset();
    loadPrefMock.mockImplementation((_key: string, fallback: unknown) => fallback);
    syncPrefCache();
    clearMediaCaches();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    // Close a lightbox a test left open, releasing its document listeners.
    closeActiveLightbox();
    // Clean up any lightboxes left on body
    document.querySelectorAll(".image-lightbox").forEach((el) => el.remove());
    document.body.innerHTML = "";
  });
}

export function lightboxImg(): HTMLElement {
  return document.body.querySelector(".image-lightbox img") as HTMLElement;
}

export function pressDocKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** Gives jsdom's layout-less <img> a 400x300 box at the origin. */
export function stubImgRect(img: HTMLElement): void {
  vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    right: 400,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/** Presses at (x, y) and releases as a click at (clickX, y). */
export function clickImgAt(img: HTMLElement, x: number, y: number, clickX = x): void {
  const init = { clientY: y, bubbles: true, cancelable: true };
  img.dispatchEvent(new MouseEvent("mousedown", { ...init, clientX: x }));
  img.dispatchEvent(new MouseEvent("click", { ...init, clientX: clickX }));
}

export function wheelOn(target: HTMLElement, deltaY: number): void {
  target.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY,
      clientX: 200,
      clientY: 150,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** The scale() factor in the image's transform; fails when there is none. */
export function scaleOf(img: HTMLElement): number {
  const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
  expect(scaleMatch).not.toBeNull();
  return parseFloat(scaleMatch![1]!);
}
