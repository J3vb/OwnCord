/**
 * File attachment rendering. The URL helpers, caches and image viewer live in
 * attachmentUrls, attachmentCache and imageViewer; this module re-exports
 * their public names so callers keep one import path.
 */

import { createElement } from "@lib/dom";
import { observeMedia } from "./mediaVisibility";
import { dataSaverActive } from "./dataSaver";
import { renderDeferredMedia } from "./deferredMedia";
import { loadPref, onPrefChange } from "@lib/prefs/preferences";
import { isVoiceAttachment, renderVoicePlayer } from "../../voice-messages/player";
import type { Attachment } from "@lib/types";
import { messagingText } from "../../../i18n/messaging";
import { isSpoilerFilename } from "../spoilerAttachment";
import { messageStatusText } from "../../../i18n/messageStatus";
import {
  fitImageBox,
  ATTACHMENT_BOX_MAX_H,
  type ImageBox,
  imageSizeGeneration,
  getImageBox,
  setImageBox,
  blobImageSize,
} from "./imageSizes";
import {
  buildDownloadButton,
  buildFileMeta,
  renderAudioAttachment,
  renderFileChip,
  renderUnshownImage,
  swapKeepingFocus,
} from "./attachmentFiles";
import { renderVideoAttachment } from "./attachmentVideo";
import { highlightCode, resolveLanguage } from "./syntaxHighlight";
import { type TextPreviewDeps, isTextPreviewable, renderTextPreview } from "../textPreview";
import {
  fetchImageAsObjectUrl,
  fetchMediaAsObjectUrl,
  fetchServerFile,
  imageCache,
  isServerUrl,
  missingImages,
  recoverEvictedImage,
  renderFailureStatus,
  shownImageUrl,
  thumbnailUrl,
} from "./attachmentCache";
import {
  bindImageMenu,
  downloadFile,
  type LightboxGallery,
  openImageLightbox,
} from "./imageViewer";
import {
  isAudioMime,
  isConvertedImageMime,
  isImageMime,
  isSafeUrl,
  isVideoAttachment,
  resolveServerUrl,
} from "./attachmentUrls";
export {
  saveImageBytes,
  bindImageMenu,
  closeActiveLightbox,
  openImageLightbox,
} from "./imageViewer";
export type {
  LightboxGalleryItem,
  LightboxGallery,
  LightboxCurrent,
  LightboxHandle,
} from "./imageViewer";
export {
  setServerHost,
  resolveServerUrl,
  formatFileSize,
  isImageMime,
  isConvertedImageMime,
  isVideoMime,
  isVideoAttachment,
  isAudioMime,
  isSafeUrl,
} from "./attachmentUrls";
export {
  IMAGE_CACHE_MAX_BYTES,
  IMAGE_DB_MAX_BYTES,
  setAttachmentCacheScope,
  pruneAttachmentCacheScope,
  clearAttachmentCaches,
  thumbnailUrl,
  shownImageUrl,
  isTrustedServerUrl,
  openCacheDb,
  fetchImageAsObjectUrl,
  cachedImageBytes,
  fetchMediaAsObjectUrl,
  externalPartition,
  EXTERNAL_IMAGE_CACHE_MAX,
  EXTERNAL_IMAGE_CACHE_MAX_BYTES,
  clearExternalImageCache,
  externalKey,
  previewExternal,
  isExternalGif,
  recoverEvictedImage,
  fetchExternalImage,
  loadExternalImage,
  renderFailureStatus,
} from "./attachmentCache";
export type { ImageLoadOptions } from "./attachmentCache";

/** Cached value of the animateGifs preference. Invalidated on pref change
 *  (same pattern as roleColors in formatting.ts). */
let animateGifsPref = loadPref<boolean>("animateGifs", true);
onPrefChange(["animateGifs"], () => {
  animateGifsPref = loadPref<boolean>("animateGifs", true);
});

/** What the text preview borrows from this module (it cannot import it). */
const textPreviewDeps: TextPreviewDeps = {
  fetchFile: fetchServerFile,
  buildFileMeta,
  buildDownloadButton,
  renderFileChip,
  highlight: (code, tag) => highlightCode(code, resolveLanguage(tag)),
};

// -- Attachment rendering -----------------------------------------------------

/** Whether `att` renders as an inline image, so it belongs in its message's
 *  lightbox sequence (3A-10c). The same test `renderAttachment` applies. */
export function isGalleryImage(att: Attachment): boolean {
  return isImageMime(att.mime) && isSafeUrl(resolveServerUrl(att.url)) && !isVideoAttachment(att);
}

/** Cover an inline image or video until the reader asks for it (6.12). The
 *  cover is a button over the blurred media, and while it is up nothing under
 *  it takes input: a capture-phase guard on the box stops the lightbox, the
 *  keyboard open, the image menu and the play button, and `inert` takes the
 *  media out of the tab order, including media that arrives after the first
 *  paint. The revealed state is this element's alone: a re-render covers it
 *  again, and nothing is stored. */
function coverSpoiler(wrap: HTMLDivElement): HTMLDivElement {
  let covered = true;
  wrap.classList.add("msg-spoiler-att");
  const cover = createElement("button", {
    class: "msg-spoiler-cover",
    type: "button",
    "aria-label": messagingText("spoiler.reveal"),
  });
  cover.appendChild(
    createElement(
      "span",
      { class: "msg-spoiler-cover-label" },
      messagingText("spoiler.attachment"),
    ),
  );

  const setInert = (on: boolean): void => {
    for (const child of wrap.children) {
      if (child !== cover) child.toggleAttribute("inert", on);
    }
  };
  const observer = new MutationObserver(() => setInert(true));
  const guard = (e: Event): void => {
    if (!covered || (e.target instanceof Node && cover.contains(e.target))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ["click", "dblclick", "auxclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(type, guard, { capture: true });
  }

  cover.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    covered = false;
    observer.disconnect();
    setInert(false);
    cover.remove();
    wrap.classList.add("revealed");
    // The cover held focus: hand it to something focusable so the keyboard
    // keeps its place. A still-loading image has nothing yet, so the box itself.
    let target = wrap.querySelector<HTMLElement>("img[tabindex], .msg-media-play, video[controls]");
    if (target === null) {
      wrap.tabIndex = -1;
      target = wrap;
    }
    target.focus();
  });

  wrap.appendChild(cover);
  setInert(true);
  observer.observe(wrap, { childList: true });
  return wrap;
}

export function renderAttachment(att: Attachment, gallery?: LightboxGallery): HTMLDivElement {
  const node = renderAttachmentContent(att, gallery);
  // Only an inline image or video is covered; a file chip or audio row shows no picture.
  return isSpoilerFilename(att.filename) && node.classList.contains("msg-image")
    ? coverSpoiler(node)
    : node;
}

/** An inline image: reserved box, cache-first load with retry, lightbox and menu. */
function renderImageAttachment(
  att: Attachment,
  resolvedUrl: string,
  gallery?: LightboxGallery,
  tapped = false,
): HTMLDivElement {
  if (!tapped && dataSaverActive()) {
    const deferred = renderDeferredMedia(
      att.filename,
      () => renderImageAttachment(att, resolvedUrl, gallery, true),
      att.size,
    );
    deferred.classList.add("msg-image");
    return deferred;
  }
  const wrap = createElement("div", { class: "msg-image" });
  // The row shows the server's preview; the lightbox loads the full file.
  const inlineUrl = thumbnailUrl(resolvedUrl, att.mime);

  // Reserve space using server-provided dimensions to prevent layout shift.
  // An old attachment has none: it takes the box remembered for its URL, or
  // the size its header declares once the bytes arrive, or 200px until then.
  const serverBox =
    att.width != null && att.height != null
      ? fitImageBox(att.width, att.height, ATTACHMENT_BOX_MAX_H)
      : null;
  const reserve = (box: ImageBox): void => {
    wrap.style.minHeight = "";
    wrap.style.width = `${box.w}px`;
    wrap.style.height = `${box.h}px`;
  };
  // A reset between mount and load must not write this URL into the new session.
  const generation = imageSizeGeneration();
  const rememberedBox = serverBox === null ? getImageBox(inlineUrl) : undefined;
  if (serverBox !== null) reserve(serverBox);
  else if (rememberedBox !== undefined) reserve(rememberedBox);
  else wrap.style.minHeight = "200px";

  function attachLightbox(img: HTMLImageElement): void {
    // Keyboard-operable like an inline image: focus it and Enter or
    // Space opens the lightbox, the Menu key or Shift+F10 the image menu.
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-label", messageStatusText("file.openImage", { filename: att.filename }));
    img.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      img.click();
    });
    img.addEventListener("click", () => {
      openImageLightbox(
        img.src,
        att.filename,
        { url: resolvedUrl },
        gallery,
        shownImageUrl(resolvedUrl, att.mime),
      );
    });
  }

  const isGif = att.mime === "image/gif";

  // Without server dimensions, settle the box on the real size once it is
  // known (a header the sniffer could not read) so a rebuild starts there.
  const clearReservation = (img: HTMLImageElement): void => {
    if (serverBox !== null) return;
    const actual = fitImageBox(img.naturalWidth, img.naturalHeight, ATTACHMENT_BOX_MAX_H);
    const reserved = getImageBox(inlineUrl);
    if (actual !== null) {
      // Decoded and oriented by the browser: the measured box beats a sniffed one.
      if (
        reserved === undefined ||
        reserved.measured !== true ||
        reserved.w !== actual.w ||
        reserved.h !== actual.h
      ) {
        reserve(actual);
        setImageBox(inlineUrl, { ...actual, measured: true }, generation);
      }
      return;
    }
    if (reserved !== undefined) return;
    // No intrinsic size reported: keep the measured height as the minimum.
    wrap.style.minHeight = "";
    const h = wrap.offsetHeight;
    if (h > 0) wrap.style.minHeight = `${h}px`;
  };

  const buildImage = (objectUrl: string): HTMLImageElement => {
    const img = createElement("img", {
      src: objectUrl,
      alt: att.filename,
      decoding: "async",
    });
    recoverEvictedImage(img, { url: inlineUrl });
    // Bytes that arrived but do not decode (a corrupt or unsupported file)
    // would leave a broken-image icon: the file chip keeps it downloadable.
    img.addEventListener(
      "error",
      () => {
        if (!wrap.isConnected) return;
        swapKeepingFocus(wrap, renderUnshownImage(att, resolvedUrl));
      },
      { once: true },
    );
    attachLightbox(img);
    bindImageMenu({
      img,
      link: null,
      // The row may show a thumbnail or a frozen GIF frame; copy the file
      // (a HEIC or TIFF has only its JPEG preview to copy).
      full: () => fetchImageAsObjectUrl(shownImageUrl(resolvedUrl, att.mime)),
      save: () => downloadFile(resolvedUrl, att.filename),
      share: () => downloadFile(resolvedUrl, att.filename, "share"),
    });
    img.addEventListener(
      "load",
      () => {
        clearReservation(img);
        if (isGif) observeMedia(img, img.src, wrap, !animateGifsPref);
      },
      { once: true },
    );
    return img;
  };

  // Check cache first for instant render
  const cached = imageCache.get(inlineUrl);
  if (cached !== undefined) {
    wrap.appendChild(buildImage(cached));
  } else {
    // Show loading placeholder, then replace with image. On failure the
    // placeholder becomes a typed failure line with a bounded retry, like the
    // external-media path — a silently un-"loading" filename box reads as
    // still-loading forever (F14).
    const placeholder = createElement("div", { class: "placeholder-img loading" }, att.filename);
    wrap.appendChild(placeholder);
    let current: Element = placeholder;

    const attempt = (): void => {
      void fetchImageAsObjectUrl(inlineUrl, { sniff: serverBox === null }).then((objectUrl) => {
        if (objectUrl !== null) {
          const sniffed = serverBox === null ? blobImageSize(objectUrl) : undefined;
          const exact =
            sniffed === undefined
              ? null
              : fitImageBox(sniffed.width, sniffed.height, ATTACHMENT_BOX_MAX_H);
          if (exact !== null) {
            // A measured box from an earlier load wins over the header's reading.
            const held = setImageBox(inlineUrl, exact, generation);
            reserve(held ?? exact);
          }
          const img = buildImage(objectUrl);
          current.replaceWith(img);
          current = img;
        } else if (isConvertedImageMime(att.mime)) {
          // No preview for this HEIC/TIFF: the file chip keeps the original downloadable.
          swapKeepingFocus(wrap, renderUnshownImage(att, resolvedUrl));
        } else {
          const failure = renderFailureStatus(
            messageStatusText("file.imageFailed"),
            messageStatusText("file.retry"),
            () => {
              // Retry asks the server again, even after a definite refusal.
              missingImages.delete(inlineUrl);
              attempt();
            },
          );
          current.replaceWith(failure);
          current = failure;
        }
      });
    };
    attempt();
  }

  return wrap;
}

function renderAttachmentContent(att: Attachment, gallery?: LightboxGallery): HTMLDivElement {
  const resolvedUrl = resolveServerUrl(att.url);
  const inlineable = isSafeUrl(resolvedUrl);
  // A voice message is recognised by its metadata, whatever MIME the server sniffed.
  if (inlineable && isVoiceAttachment(att)) {
    return renderVoicePlayer(att, resolvedUrl, {
      fetchMedia: fetchMediaAsObjectUrl,
      downloadButton: () => buildDownloadButton(att, resolvedUrl),
    });
  }
  if (inlineable && isVideoAttachment(att)) {
    return renderVideoAttachment(att, resolvedUrl);
  }
  if (inlineable && isAudioMime(att.mime)) {
    return renderAudioAttachment(att, resolvedUrl);
  }
  if (isImageMime(att.mime) && inlineable) return renderImageAttachment(att, resolvedUrl, gallery);
  if (inlineable && isServerUrl(resolvedUrl) && isTextPreviewable(att)) {
    return renderTextPreview(att, resolvedUrl, textPreviewDeps);
  }
  return renderFileChip(att, resolvedUrl);
}
