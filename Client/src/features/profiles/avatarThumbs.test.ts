import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<string | null>>());
const animatedThumbs = vi.hoisted(() => new Set<string>());

// Own-server file URLs have a preview, as the real smallThumbnailUrl decides it; anything else
// does not.
vi.mock("../messaging/content/attachments", () => ({
  attachmentCacheGeneration: () => 0,
  fetchImageAsObjectUrl,
  hasCachedImage: () => false,
  cachedImageBytes: () => null,
  isAnimatedThumb: (objectUrl: string) => animatedThumbs.has(objectUrl),
  smallThumbnailUrl: (url: string, size: number) =>
    url.startsWith("https://server.test/api/v1/files/") ? `${url}/thumb?size=${size}` : null,
  recoverEvictedImage: () => {},
  isSafeUrl: (url: string) => url.startsWith("https://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

const { createAvatarElement } = await import("./avatar");

const FILE = "https://server.test/api/v1/files/abc";
const subject = { username: "ada", avatar: "/api/v1/files/abc" };

/** jsdom has no pointer, so a row is "hovered" while this says so. */
let hovered = false;

/** A message row holding an avatar, attached, as the list builds it. */
function inRow(el: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "message";
  Object.defineProperty(row, "matches", {
    value: (selector: string): boolean => hovered && selector === ":hover",
  });
  row.appendChild(el);
  document.body.appendChild(row);
  return row;
}

describe("createAvatarElement previews", () => {
  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    animatedThumbs.clear();
    hovered = false;
    document.documentElement.classList.remove("reduced-motion");
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("asks for the 128 px preview by default and shows it without fetching the original", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:small");
    const el = createAvatarElement(subject, { className: "msg-avatar" });
    inRow(el);
    await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:small"));
    expect(fetchImageAsObjectUrl.mock.calls.map(([url]) => url)).toEqual([
      `${FILE}/thumb?size=128`,
    ]);
    // Pointing at the row does not fetch the original of a picture that does not move.
    el.closest(".message")?.dispatchEvent(new Event("pointerenter"));
    await Promise.resolve();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("asks for the 256 px preview when a profile surface says so", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:medium");
    const el = createAvatarElement(subject, { className: "upp-avatar", thumbSize: 256 });
    inRow(el);
    await vi.waitFor(() => expect(el.querySelector("img")).not.toBeNull());
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith(`${FILE}/thumb?size=256`);
  });

  it("fetches an external avatar as it is", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:external");
    const el = createAvatarElement(
      { username: "ada", avatar: "https://cdn.example/a.png" },
      { className: "msg-avatar" },
    );
    inRow(el);
    await vi.waitFor(() => expect(el.querySelector("img")).not.toBeNull());
    expect(fetchImageAsObjectUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://cdn.example/a.png",
    ]);
  });

  it("falls back to the original when the preview cannot be fetched", async () => {
    fetchImageAsObjectUrl.mockImplementation((url) =>
      Promise.resolve(url.includes("/thumb") ? null : "blob:original"),
    );
    const el = createAvatarElement(subject, { className: "msg-avatar" });
    inRow(el);
    await vi.waitFor(() =>
      expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:original"),
    );
    expect(fetchImageAsObjectUrl.mock.calls.map(([url]) => url)).toEqual([
      `${FILE}/thumb?size=128`,
      FILE,
    ]);
  });

  it("keeps the letter when neither the preview nor the original arrives", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const el = createAvatarElement(subject, { className: "msg-avatar" });
    inRow(el);
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(2));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".avatar-initial")).not.toBeNull();
  });

  describe("an animated avatar", () => {
    beforeEach(() => {
      animatedThumbs.add("blob:still");
      fetchImageAsObjectUrl.mockImplementation((url) =>
        Promise.resolve(url.includes("/thumb") ? "blob:still" : "blob:gif"),
      );
    });

    it("shows the preview and fetches the original only when its row is hovered", async () => {
      const el = createAvatarElement(subject, { className: "msg-avatar" });
      const row = inRow(el);
      await vi.waitFor(() =>
        expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:still"),
      );
      expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);

      hovered = true;
      row.dispatchEvent(new Event("pointerenter"));
      await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:gif"));
      expect(fetchImageAsObjectUrl).toHaveBeenLastCalledWith(FILE);
      expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(2);

      hovered = false;
      row.dispatchEvent(new Event("pointerleave"));
      expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:still");
      // Hovering again plays the original already fetched: one fetch of it in all.
      hovered = true;
      row.dispatchEvent(new Event("pointerenter"));
      expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:gif");
      expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(2);
    });

    it("plays at once where it always plays, but not under reduced motion", async () => {
      const el = createAvatarElement(subject, {
        className: "upp-avatar",
        animate: "always",
        thumbSize: 256,
      });
      inRow(el);
      await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:gif"));

      fetchImageAsObjectUrl.mockClear();
      document.documentElement.classList.add("reduced-motion");
      const still = createAvatarElement(subject, { className: "upp-avatar", animate: "always" });
      inRow(still);
      await vi.waitFor(() =>
        expect(still.querySelector("img")?.getAttribute("src")).toBe("blob:still"),
      );
      expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    });

    it("stays a still when the original cannot be fetched", async () => {
      fetchImageAsObjectUrl.mockImplementation((url) =>
        Promise.resolve(url.includes("/thumb") ? "blob:still" : null),
      );
      const el = createAvatarElement(subject, { className: "msg-avatar" });
      const row = inRow(el);
      await vi.waitFor(() => expect(el.querySelector("img")).not.toBeNull());
      row.dispatchEvent(new Event("pointerenter"));
      await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(2));
      expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:still");
    });

    it("waits for a picture drawn before its row was shown to be pointed at", async () => {
      const el = createAvatarElement(subject, { className: "msg-avatar" });
      await vi.waitFor(() =>
        expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:still"),
      );
      expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
      document.body.appendChild(el);
      Object.defineProperty(el, "matches", {
        value: (selector: string): boolean => selector === ":hover",
      });
      el.dispatchEvent(new Event("pointerenter"));
      await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:gif"));
    });
  });
});
