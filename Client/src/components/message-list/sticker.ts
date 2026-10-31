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
 */

import { createElement } from "@lib/dom";
import type { MessageStickerInfo } from "@lib/types";
import { showStillFrame } from "../../features/messaging/emojiStill";
import { stickersText } from "../../i18n/stickers";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../../features/messaging/content/attachments";

/** Whether motion is reduced, by the OS setting or the in-app toggle (os-motion.ts owns the class). */
export function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduced-motion");
}

/**
 * Load a sticker's bytes into `img`. `host` is the element whose hover and
 * focus play an animated sticker under reduced motion; it gets a tabindex then,
 * so the keyboard can play it too. Everything is owned by `signal`.
 */
export function loadStickerImage(
  img: HTMLImageElement,
  host: HTMLElement,
  url: string,
  signal: AbortSignal,
  onMissing?: () => void,
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
  loadStickerImage(img, wrap, sticker.url, signal, () => wrap.replaceWith(deletedBox()));
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
