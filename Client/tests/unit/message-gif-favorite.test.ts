import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, imageMock } = vi.hoisted(() => ({ previewMock: vi.fn(), imageMock: vi.fn() }));

vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));
vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));

import {
  renderInlineImage,
  setInlineImageDecorator,
} from "../../src/components/message-list/media";
import { gifFavoriteStar } from "../../src/components/message-list/gifFavoriteStar";
import {
  bindGifFavoritesApi,
  isGifFavorite,
  resetGifFavorites,
  toggleGifFavorite,
} from "@stores/gifFavorites.store";
import { showToast } from "@lib/ui/toast";
import { ApiClientError } from "@lib/api";
import type { GifFavoritesApi } from "@lib/media/gifProvider";

vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));

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
    setInlineImageDecorator(gifFavoriteStar);
    URL.createObjectURL = vi.fn(() => "blob:test/1");
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/gif" }) });
  });

  it("has no star when favorites are unavailable", () => {
    expect(renderInlineImage(URL_).querySelector(".msg-gif-fav")).toBeNull();
  });

  it("has no star while a rebind is pending after an older server answered 404", async () => {
    const old = api();
    old.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "nope"));
    bindGifFavoritesApi(old);
    await flush();
    const pending = api();
    pending.gifFavorites = vi.fn(() => new Promise<never>(() => {}));
    bindGifFavoritesApi(pending);
    const star = renderInlineImage(URL_).querySelector<HTMLButtonElement>(".msg-gif-fav");
    expect(star === null || star.hidden).toBe(true);
  });

  it("a star drawn before a 404 hides on hover, but not while it holds focus", async () => {
    const pendingApi = api();
    let reject!: (e: unknown) => void;
    pendingApi.gifFavorites = vi.fn(() => new Promise<never>((_, r) => (reject = r)));
    bindGifFavoritesApi(pendingApi);
    const wrap = renderInlineImage(URL_);
    document.body.appendChild(wrap);
    const star = wrap.querySelector<HTMLButtonElement>(".msg-gif-fav")!;
    const other = renderInlineImage(URL_).querySelector<HTMLButtonElement>(".msg-gif-fav")!;
    document.body.appendChild(other.parentElement!);
    // Focus is taken while the star is still shown; a hidden one cannot take it.
    star.focus();
    reject(new ApiClientError(404, "NOT_FOUND", "nope"));
    await flush();
    expect(star.hidden).toBe(false);
    expect(document.activeElement).toBe(star);
    star.blur();
    expect(star.hidden).toBe(true);
    other.dispatchEvent(new Event("pointerenter"));
    expect(other.hidden).toBe(true);
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
    const wrapClick = vi.fn();
    wrap.addEventListener("click", wrapClick);
    wrap.querySelector<HTMLButtonElement>(".msg-gif-fav")!.click();
    expect(wrapClick).not.toHaveBeenCalled();
  });

  it("re-syncs a rendered star when the list changes elsewhere", async () => {
    const a = api([URL_]);
    bindGifFavoritesApi(a);
    await flush();
    const wrap = renderInlineImage(URL_);
    document.body.appendChild(wrap);
    const star = wrap.querySelector<HTMLButtonElement>(".msg-gif-fav")!;
    expect(star.classList.contains("on")).toBe(true);
    await toggleGifFavorite({ url: URL_, preview_url: URL_, title: "" });
    expect(star.classList.contains("on")).toBe(false);
    wrap.remove();
  });

  it("toasts when saving fails, naming the cap on GIF_FAVORITES_FULL", async () => {
    const a = api();
    a.addGifFavorite = vi
      .fn()
      .mockRejectedValue(new ApiClientError(409, "GIF_FAVORITES_FULL", "full"));
    bindGifFavoritesApi(a);
    await flush();
    renderInlineImage(URL_).querySelector<HTMLButtonElement>(".msg-gif-fav")!.click();
    await flush();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("limit"), "error");
  });

  it("toasts when toggling while the favorites load has failed", async () => {
    const a = api();
    a.gifFavorites = vi.fn().mockRejectedValue(new ApiClientError(500, "INTERNAL_ERROR", "boom"));
    bindGifFavoritesApi(a);
    await flush();
    expect(await toggleGifFavorite({ url: URL_, preview_url: URL_, title: "" })).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
  });
});
