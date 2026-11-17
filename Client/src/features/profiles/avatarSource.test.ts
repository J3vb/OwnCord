import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<string | null>>());
const smallThumbnailUrl = vi.hoisted(() => vi.fn<(url: string, size: number) => string | null>());

vi.mock("../messaging/content/attachments", () => ({ fetchImageAsObjectUrl, smallThumbnailUrl }));

const { avatarFetchUrl, fetchAvatarObjectUrl, playOriginalOnEngage } =
  await import("./avatarSource");

describe("avatarFetchUrl and fetchAvatarObjectUrl", () => {
  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    smallThumbnailUrl.mockReset();
  });

  it("uses the preview when there is one and the URL itself when there is not", () => {
    smallThumbnailUrl.mockReturnValueOnce("https://s/f/thumb?size=256");
    expect(avatarFetchUrl("https://s/f", 256)).toBe("https://s/f/thumb?size=256");
    expect(smallThumbnailUrl).toHaveBeenCalledWith("https://s/f", 256);
    smallThumbnailUrl.mockReturnValueOnce(null);
    expect(avatarFetchUrl("https://cdn/a.png", 128)).toBe("https://cdn/a.png");
  });

  it("fetches an avatar with no preview once, as it is", async () => {
    smallThumbnailUrl.mockReturnValue(null);
    fetchImageAsObjectUrl.mockResolvedValue(null);
    expect(await fetchAvatarObjectUrl("https://cdn/a.png", 128)).toBeNull();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("returns the preview without touching the original", async () => {
    smallThumbnailUrl.mockReturnValue("https://s/f/thumb?size=128");
    fetchImageAsObjectUrl.mockResolvedValue("blob:small");
    expect(await fetchAvatarObjectUrl("https://s/f", 128)).toBe("blob:small");
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
  });
});

describe("playOriginalOnEngage", () => {
  const still = "blob:still";
  let row: HTMLElement;
  let img: HTMLImageElement;

  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    fetchImageAsObjectUrl.mockResolvedValue("blob:gif");
    document.documentElement.classList.remove("reduced-motion");
    document.body.replaceChildren();
    row = document.createElement("div");
    img = document.createElement("img");
    img.src = still;
    row.appendChild(img);
    document.body.appendChild(row);
  });

  it("fetches nothing until the row is pointed at, and then once", async () => {
    // jsdom has no pointer: the row is hovered once the test says so.
    let hovered = false;
    Object.defineProperty(row, "matches", {
      value: (selector: string): boolean => hovered && selector === ":hover",
    });
    playOriginalOnEngage(img, still, "https://s/f", { hover: row });
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
    hovered = true;
    row.dispatchEvent(new Event("pointerenter"));
    row.dispatchEvent(new Event("focusin"));
    row.dispatchEvent(new Event("pointerenter"));
    await vi.waitFor(() => expect(img.src).toBe("blob:gif"));
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://s/f");
  });

  it("fetches at once for an avatar that always plays, never under reduced motion", async () => {
    playOriginalOnEngage(img, still, "https://s/f", "always");
    await vi.waitFor(() => expect(img.src).toBe("blob:gif"));

    fetchImageAsObjectUrl.mockClear();
    document.documentElement.classList.add("reduced-motion");
    playOriginalOnEngage(img, still, "https://s/f", "always");
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
  });

  it("leaves the still when the original does not arrive", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    playOriginalOnEngage(img, still, "https://s/f", { hover: row });
    row.dispatchEvent(new Event("pointerenter"));
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1));
    expect(img.src).toBe(still);
  });

  it("does not bind the original once the avatar was replaced meanwhile", async () => {
    let replaced = false;
    playOriginalOnEngage(img, still, "https://s/f", "always", () => !replaced);
    replaced = true;
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(img.src).toBe(still);
  });
});
