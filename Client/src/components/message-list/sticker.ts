/**
 * Custom stickers in the message list and the picker.
 *
 * A sticker message has no text body: the image stands alone at 160x160, and a
 * sticker deleted since it was sent leaves a small grey "Deleted sticker: name"
 * box (the server keeps the name, drops the id and url).
 *
 * The image is behind the session token, so it is fetched through the same
 * cert-pinned, bearer-token path attachments and custom emoji use and swapped
 * in as a blob: URL. Assigning the server URL to `img.src` would 401.
 *
 * Reduced motion: an animated sticker must not autoplay. Under the reduced
 * motion class the image shows its first frame (the same capture "Animate
 * emoji" off uses) and plays only while the pointer or keyboard focus is on it.
 *
 * Otherwise an animated sticker in a message behaves like a GIF: it follows
 * "Animate GIFs", pauses after a few seconds or when it scrolls away, and
 * plays again from its ▶ button, on hover, or on a tap. A still sticker gets
 * no button.
 */

import { createElement } from "@lib/dom";
import { observeMedia, playMedia } from "@lib/prefs/mediaVisibility";
import { loadPref } from "@lib/prefs/preferences";
import { isAnimatedImage } from "@lib/ui/animatedStill";
import type { MessageStickerInfo } from "@lib/types";
import { showStillFrame } from "../../features/messaging/emojiStill";
import { stickersText } from "../../i18n/stickers";
import {
  cachedImageBytes,
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../../features/messaging/content/attachments";

/** Whether motion is reduced, by the OS setting or the in-app toggle (os-motion.ts owns the class). */
export function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduced-motion");
}

/**
 * Hand an animated sticker to the GIF pause logic once it has loaded, with
 * `host` as the wrapper that carries the ▶ button. Hover on `host` and a tap
 * on the image play it again.
 */
function pauseLikeGifs(
  img: HTMLImageElement,
  host: HTMLElement,
  objectUrl: string,
  signal: AbortSignal,
): void {
  const read = cachedImageBytes(objectUrl);
  if (read === null) return;
  void read()
    .then((bytes) => {
      if (signal.aborted || bytes === null || !isAnimatedImage(bytes)) return;
      const start = (): void => {
        if (signal.aborted) return;
        observeMedia(img, objectUrl, host, !loadPref<boolean>("animateGifs", true));
        host.addEventListener("pointerenter", () => playMedia(img), { signal });
        img.addEventListener("click", () => playMedia(img), { signal });
      };
      if (img.complete && img.naturalWidth > 0) start();
      else img.addEventListener("load", start, { once: true, signal });
    })
    .catch(() => undefined);
}

/**
 * Load a sticker's bytes into `img`. `host` is the element whose hover and
 * focus play an animated sticker under reduced motion; it gets a tabindex then,
 * so the keyboard can play it too. With `autoPause`, an animated sticker
 * pauses like a GIF otherwise. Everything is owned by `signal`.
 */
export function loadStickerImage(
  img: HTMLImageElement,
  host: HTMLElement,
  url: string,
  signal: AbortSignal,
  onMissing?: () => void,
  autoPause = false,
): void {
  const full = resolveServerUrl(url);
  recoverEvictedImage(img, { url: full });
  void fetchImageAsObjectUrl(full).then((objectUrl) => {
    if (signal.aborted) return;
    // The server no longer has the image (a sticker deleted after this message
    // was cached or replayed): the caller shows the deleted box instead.
    if (objectUrl === null) {
      onMissing?.();
      return;
    }
    if (!motionReduced()) {
      img.src = objectUrl;
      if (autoPause) pauseLikeGifs(img, host, objectUrl, signal);
      return;
    }
    showStillFrame(img, objectUrl);
    if (!host.hasAttribute("tabindex")) host.setAttribute("tabindex", "0");
    const play = (): void => {
      img.src = objectUrl;
    };
    const rest = (): void => showStillFrame(img, objectUrl);
    host.addEventListener("mouseenter", play, { signal });
    host.addEventListener("focusin", play, { signal });
    host.addEventListener("mouseleave", rest, { signal });
    host.addEventListener("focusout", rest, { signal });
  });
}

/** The body of a sticker message: the image, or the deleted-sticker box. */
export function renderStickerBody(sticker: MessageStickerInfo, signal: AbortSignal): HTMLElement {
  const deletedBox = (): HTMLElement =>
    createElement(
      "div",
      { class: "msg-sticker-deleted", "data-testid": "sticker-deleted" },
      stickersText("message.deleted", { name: sticker.name }),
    );
  if (sticker.id === null || sticker.url === null) return deletedBox();
  const alt = stickersText("message.alt", { name: sticker.name });
  const wrap = createElement("div", {
    class: "msg-sticker",
    "data-testid": "sticker-message",
    "data-sticker-id": String(sticker.id),
  });
  const img = createElement("img", {
    class: "msg-sticker-img",
    alt,
    title: sticker.name,
    draggable: "false",
    loading: "lazy",
  });
  wrap.appendChild(img);
  loadStickerImage(img, wrap, sticker.url, signal, () => wrap.replaceWith(deletedBox()), true);
  return wrap;
}

/**
 * What a reply preview says about a sticker message. A sticker message's text
 * is the server's fallback `[Sticker: name]` (and a reply snippet carries only
 * text), so the name is read back from it; null for any other text.
 */
export function stickerReplyPreview(content: string): string | null {
  const match = /^\[Sticker: (.+)\]$/.exec(content);
  return match === null ? null : stickersText("reply.preview", { name: match[1] ?? "" });
}

/** The same preview for a message the list already holds. */
export function stickerReplyText(
  sticker: MessageStickerInfo | undefined,
  content: string,
): string | null {
  if (sticker !== undefined) return stickersText("reply.preview", { name: sticker.name });
  return stickerReplyPreview(content);
}
