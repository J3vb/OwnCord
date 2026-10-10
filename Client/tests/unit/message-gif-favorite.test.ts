import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, imageMock } = vi.hoisted(() => ({ previewMock: vi.fn(), imageMock: vi.fn() }));

vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));
vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));

import { renderInlineImage } from "../../src/components/message-list/media";
import { bindGifFavoritesApi, isGifFavorite, resetGifFavorites } from "@stores/gifFavorites.store";
import type { GifFavoritesApi } from "@lib/gifProvider";

const URL_ = "https://media.klipy.com/full/cat.gif";
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function api(initial: readonly string[] = []): GifFavoritesApi {
  return {
    gifFavorites: vi.fn().mockResolvedValue({
      favorites: initial.map((url) => ({ url, preview_url: url, title: "" })),
    }),
    addGifFavorite: vi.fn().mockResolvedValue(undefined),
    removeGifFavorite: vi.fn().mockResolvedValue(undefined),
  };
}

describe("star on GIFs in messages", () => {
  beforeEach(() => {
    resetGifFavorites();
    URL.createObjectURL = vi.fn(() => "blob:test/1");
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/gif" }) });
  });

  it("has no star when favorites are unavailable", () => {
    expect(renderInlineImage(URL_).querySelector(".msg-gif-fav")).toBeNull();
  });

  it("has no star on a non-Klipy image", async () => {
    bindGifFavoritesApi(api());
    await flush();
    expect(renderInlineImage("https://example.com/a.gif").querySelector(".msg-gif-fav")).toBeNull();
  });

  it("clicking the star saves the GIF and shows it pressed", async () => {
    const a = api();
    bindGifFavoritesApi(a);
    await flush();
    const star = renderInlineImage(URL_).querySelector<HTMLButtonElement>(".msg-gif-fav")!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    star.click();
    await flush();
    expect(a.addGifFavorite).toHaveBeenCalledWith({ url: URL_, preview_url: URL_, title: "" });
    expect(isGifFavorite(URL_)).toBe(true);
    expect(star.getAttribute("aria-pressed")).toBe("true");
  });

  it("starts pressed for an already-saved GIF and unsaves on click", async () => {
    const a = api([URL_]);
    bindGifFavoritesApi(a);
    await flush();
    const star = renderInlineImage(URL_).querySelector<HTMLButtonElement>(".msg-gif-fav")!;
    expect(star.getAttribute("aria-pressed")).toBe("true");
    star.click();
    await flush();
    expect(a.removeGifFavorite).toHaveBeenCalledWith(URL_);
    expect(star.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not open the lightbox when the star is clicked", async () => {
    bindGifFavoritesApi(api());
    await flush();
    const wrap = renderInlineImage(URL_);
    const imgClick = vi.fn();
    wrap.querySelector("img")!.addEventListener("click", imgClick);
    wrap.querySelector<HTMLButtonElement>(".msg-gif-fav")!.click();
    expect(imgClick).not.toHaveBeenCalled();
  });
});
