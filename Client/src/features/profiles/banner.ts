/**
 * Profile banner painting, shared by the profile popup, the DM
 * side panel and the Account settings card.
 *
 * - An image: the strip grows to 120 px (5:2 on the popup's 300 px card) and
 *   the avatar follows through `--upp-banner-h`. The picture is fetched lazily
 *   through the authenticated, cert-pinned path (`<img src>` cannot carry the
 *   session token) and swapped in; until then, or if the fetch fails, the
 *   colour or the gradient shows.
 * - A colour only: the strip keeps its height and takes the colour, but only
 *   one that matches `HEX_COLOR` - the value lands in a style, so a stray
 *   string must never reach it.
 * - Neither: the surface's own default (the accent gradient).
 *
 * The cache behind `fetchImageAsObjectUrl` owns the `blob:` URL (it revokes on
 * eviction and on a session change), so nothing here revokes or keeps one: a
 * fetch that resolves after the surface closed is simply not applied.
 */

import { bindAnimatedImage } from "@lib/ui/animatedStill";
import { createElement } from "@lib/dom";

/**
 * How a banner picture is loaded. Each surface passes the helpers in from
 * `bannerImages.ts`, so this module does not load the attachment cache.
 */
export interface BannerImages {
  /** The authenticated fetch behind the attachment cache; null on failure. */
  readonly fetch: (url: string) => Promise<string | null>;
  /** The server-relative path as a full URL. */
  readonly resolve: (path: string) => string;
  /** Reload `img` if its `blob:` URL was evicted from the cache. */
  readonly recover: (img: HTMLImageElement, url: string) => void;
  /** The first frame of a fetched picture when it is animated, else
   *  null. An animated banner plays, except under reduced motion. */
  readonly still: (objectUrl: string) => Promise<string | null>;
}

/** What a member carries: undefined/null/"" all mean "not set". */
export interface BannerFields {
  readonly banner?: string | null;
  readonly banner_color?: string | null;
}

/** The only colour shapes the server stores (`#rgb`, `#rrggbb`). */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Height of a strip that shows a picture: 5:2 on the 300 px popup card. */
const IMAGE_STRIP_HEIGHT = "120px";
const HEIGHT_VAR = "--upp-banner-h";

/** Whether `value` is a banner colour the server could have stored. */
export function isBannerColor(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/**
 * Paint `fields` onto the banner strip `el`. Safe to call again on the same
 * strip: the previous picture and colour are cleared first, and a fetch that
 * finishes for an older call is dropped. `card` is the element that holds the
 * strip and the avatar (default: the strip's parent), where `--upp-banner-h`
 * is set so both follow it.
 */
export function paintBanner(
  el: HTMLElement,
  fields: BannerFields,
  card: HTMLElement | null,
  images: BannerImages,
): void {
  const holder = card ?? el;
  const path = fields.banner;
  const samePicture =
    typeof path === "string" &&
    path !== "" &&
    el.dataset["bannerSrc"] === path &&
    holder.style.getPropertyValue(HEIGHT_VAR) !== "";
  if (samePicture) {
    // Only the colour can have changed: keep the picture (shown or loading).
    el.style.background = isBannerColor(fields.banner_color) ? fields.banner_color : "";
    return;
  }

  el.replaceChildren();
  el.style.background = "";
  holder.style.removeProperty(HEIGHT_VAR);
  el.removeAttribute("data-banner-src");

  if (isBannerColor(fields.banner_color)) el.style.background = fields.banner_color;

  if (typeof path !== "string" || path === "") return;

  // Reserve the picture's height at once so the card does not jump when the
  // bytes arrive; it is given back if they never do.
  holder.style.setProperty(HEIGHT_VAR, IMAGE_STRIP_HEIGHT);
  el.dataset["bannerSrc"] = path;
  const url = images.resolve(path);
  // The surface closed, or the banner changed, while the file loaded.
  const current = (): boolean => el.isConnected && el.dataset["bannerSrc"] === path;
  void images.fetch(url).then(async (objectUrl) => {
    if (!current()) return;
    if (objectUrl === null) {
      holder.style.removeProperty(HEIGHT_VAR);
      return;
    }
    const still = await images.still(objectUrl);
    if (!current()) return;
    const img = createElement("img", { class: "banner-img", alt: "" });
    images.recover(img, url);
    if (still === null) img.src = objectUrl;
    else bindAnimatedImage(img, objectUrl, still, "always");
    el.replaceChildren(img);
  });
}
