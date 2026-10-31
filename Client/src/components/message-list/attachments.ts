/**
 * File attachment rendering. The URL helpers, caches and image viewer live in
 * attachmentUrls, attachmentCache and imageViewer; this module re-exports
 * their public names so callers keep one import path.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { observeMedia } from "@lib/prefs/mediaVisibility";
import { loadPref, onPrefChange } from "@lib/prefs/preferences";
import { isVoiceAttachment, renderVoicePlayer } from "../../features/voice-messages/player";
import type { Attachment } from "@lib/types";
import { messagingText } from "../../i18n/messaging";
import { isSpoilerFilename } from "../../features/messaging/spoilerAttachment";
import { messageStatusText } from "../../i18n/messageStatus";
import {
  fitImageBox,
  ATTACHMENT_BOX_MAX_H,
  type ImageBox,
  imageSizeGeneration,
  getImageBox,
  setImageBox,
  blobImageSize,
} from "./imageSizes";
import { highlightCode, resolveLanguage } from "./syntaxHighlight";
import {
  type TextPreviewDeps,
  isTextPreviewable,
  renderTextPreview,
} from "../../features/messaging/textPreview";
import {
  fetchImageAsObjectUrl,
  fetchMediaAsObjectUrl,
  fetchServerFile,
  type FileLink,
  getFileLink,
  imageCache,
  isServerUrl,
  missingImages,
  recoverEvictedImage,
  renderFailureStatus,
  shownImageUrl,
  thumbnailUrl,
  VIDEO_DIMS_CAP,
  videoDims,
} from "./attachmentCache";
import {
  bindImageMenu,
  downloadFile,
  type LightboxGallery,
  openImageLightbox,
} from "./imageViewer";
import {
  formatFileSize,
  isAudioMime,
  isConvertedImageMime,
  isImageMime,
  isSafeUrl,
  isVideoAttachment,
  log,
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

/** The filename + size + download row shared by the audio player and the
 *  generic file chip. */
function buildFileMeta(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const info = createElement("div", { class: "msg-file-meta" });
  const nameEl = createElement("div", { class: "msg-file-name" }, att.filename);
  nameEl.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  const sizeEl = createElement("div", { class: "msg-file-size" }, formatFileSize(att.size));
  appendChildren(info, nameEl, sizeEl);
  return info;
}

/** The circular download button used by every non-image attachment shape. */
function buildDownloadButton(att: Attachment, resolvedUrl: string): HTMLButtonElement {
  const btn = createElement("button", {
    class: "msg-file-download",
    title: messageStatusText("file.download"),
    "aria-label": messageStatusText("file.downloadNamed", { filename: att.filename }),
  });
  btn.appendChild(createIcon("download", 16));
  btn.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  return btn;
}

/** The play button that stands in for a player until the viewer asks for the
 *  clip, so a row that only scrolls past downloads nothing (the whole
 *  file on the first play). Native controls are inert without a
 *  source, so they arrive with it. A failed download keeps the button:
 *  pressing it again retries. */
function buildPlayButton(
  att: Attachment,
  resolvedUrl: string,
  wrap: HTMLElement,
  player: HTMLMediaElement,
): HTMLButtonElement {
  const btn = createElement("button", {
    class: "msg-media-play",
    type: "button",
    "aria-label": messageStatusText("file.playNamed", { filename: att.filename }),
  });
  const playLabel = btn.getAttribute("aria-label") ?? "";
  btn.appendChild(createIcon("play", 20));
  const setLoading = (loading: boolean): void => {
    btn.disabled = loading;
    btn.replaceChildren(createIcon(loading ? "loader" : "play", 20));
    if (loading) {
      btn.setAttribute("aria-busy", "true");
      btn.setAttribute(
        "aria-label",
        messageStatusText("file.loadingNamed", { filename: att.filename }),
      );
      wrap.setAttribute("aria-busy", "true");
    } else {
      btn.removeAttribute("aria-busy");
      btn.setAttribute("aria-label", playLabel);
      wrap.removeAttribute("aria-busy");
    }
  };
  btn.addEventListener("click", () => {
    // The whole clip downloads first on this path, so say so: a big file
    // would otherwise look like a dead button.
    setLoading(true);
    void fetchMediaAsObjectUrl(resolvedUrl).then((objectUrl) => {
      if (objectUrl === null) {
        // The download chip stays; the player is dimmed, never shown as loading.
        wrap.classList.add("msg-media-failed");
        setLoading(false);
        return;
      }
      wrap.removeAttribute("aria-busy");
      wrap.classList.remove("msg-media-failed");
      btn.remove();
      player.hidden = false;
      player.controls = true;
      player.src = objectUrl;
      if (!wrap.isConnected) return;
      void player.play().catch((err: unknown) => {
        // Playback refused (an autoplay policy): the controls are there to press.
        log.debug("Media playback refused", { error: String(err) });
      });
    });
  });
  return btn;
}

/** Replace `wrap` with `next`, handing keyboard focus on if `wrap` held it. */
function swapKeepingFocus(wrap: HTMLElement, next: HTMLElement): void {
  const hadFocus = wrap.contains(document.activeElement);
  wrap.replaceWith(next);
  if (hadFocus) next.querySelector<HTMLElement>(".msg-file-download")?.focus();
}

/** Largest box an inline video is drawn in, in CSS pixels: the cap an inline
 *  image is shown at (400 wide by the reserved box, 300 tall by CSS). */
const VIDEO_MAX_W = 400;
const VIDEO_MAX_H = 300;
/** Narrowest player, so the play and download buttons and the native controls
 *  still fit a tiny or very tall clip. */
const VIDEO_MIN_W = 120;

/** Size the player to the clip's own shape, scaled down to the video box, so
 *  a small or portrait video gets no black bars. Below VIDEO_MIN_W the player
 *  is widened, and a box that would then pass VIDEO_MAX_H is letterboxed. The
 *  width is a ceiling: a narrow column still shrinks it, keeping the ratio. */
function sizeVideo(video: HTMLVideoElement, w: number, h: number): void {
  const scale = Math.min(1, VIDEO_MAX_W / w, VIDEO_MAX_H / h);
  const scaled = Math.round(w * scale);
  const width = Math.max(VIDEO_MIN_W, scaled);
  const fits = scaled >= VIDEO_MIN_W || (width * h) / w <= VIDEO_MAX_H;
  video.style.width = `${width}px`;
  video.style.aspectRatio = fits ? `${w} / ${h}` : `${width} / ${VIDEO_MAX_H}`;
}

/** The audio row a picture-less clip becomes keeps streaming from the link,
 *  so it gets the same recovery as the player: one fresh link, then the play
 *  button's download path. */
function watchAudioLink(
  att: Attachment,
  resolvedUrl: string,
  row: HTMLElement,
  audio: HTMLAudioElement,
): void {
  const downloadPath = (): void => {
    audio.removeAttribute("src");
    audio.load();
    audio.hidden = true;
    audio.controls = false;
    row.querySelector(".msg-file-meta")?.appendChild(buildPlayButton(att, resolvedUrl, row, audio));
  };
  audio.addEventListener(
    "error",
    () => {
      const at = audio.currentTime;
      const wasPlaying = !audio.paused;
      void getFileLink(resolvedUrl, true).then((link) => {
        if (link === null) {
          downloadPath();
          return;
        }
        // A second failure is the download path's to settle.
        audio.addEventListener("error", downloadPath, { once: true });
        audio.addEventListener(
          "loadedmetadata",
          () => {
            audio.currentTime = at;
            if (wasPlaying && row.isConnected) {
              void audio.play().catch((err: unknown) => {
                log.debug("Media playback refused", { error: String(err) });
              });
            }
          },
          { once: true },
        );
        audio.src = link.src;
      });
    },
    { once: true },
  );
}

/** MediaError.code for "the stream arrived and could not be decoded". Every
 *  other code, a refused request included, is ambiguous, so it earns the
 *  fresh-link retry before the clip is called unplayable. */
const MEDIA_ERR_DECODE = 3;
/** A link that fails again within this long of its replacement is not
 *  replaced a second time: the clip goes to the blob path. */
const VIDEO_RELINK_COOLDOWN_MS = 60_000;

/** Inline <video> player, capped to the same box as an image and sized to the
 *  clip's real shape once it is known (server dimensions, an earlier play, or
 *  the metadata). The source is a server-minted link, so the engine streams
 *  with Range requests and shows the first frame before play. When a link
 *  cannot be had (an older server, a failed request), or keeps failing, the
 *  play button downloads the clip through the authenticated fetch instead.
 *  A clip the engine cannot decode becomes the download chip, never a broken
 *  player. */
function renderVideoAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-image msg-video" });

  const video = createElement("video", { preload: "metadata" });
  video.setAttribute("aria-label", att.filename);
  const known =
    att.width != null && att.height != null && att.width > 0 && att.height > 0
      ? ([att.width, att.height] as const)
      : videoDims.get(att.id);
  if (known !== undefined) sizeVideo(video, known[0], known[1]);
  const unplayable = (): void => {
    const chip = renderFileChip(att, resolvedUrl);
    const note = createElement("div", { class: "msg-file-note", role: "status" });
    setText(note, messageStatusText("file.cannotPlay"));
    chip.querySelector(".msg-file-meta")?.appendChild(note);
    swapKeepingFocus(wrap, chip);
  };

  // "link": streaming from a minted link. "blob": the play button's download
  // path (also the state before any link has arrived).
  let source: "link" | "blob" = "blob";
  let playButton: HTMLButtonElement | null = null;
  let relinking = false;
  let lastRelinkAt = Number.NEGATIVE_INFINITY;
  let resumeAt = 0;
  let resumePlaying = false;

  const useBlobPath = (): void => {
    source = "blob";
    video.removeAttribute("src");
    video.load();
    video.controls = false;
    if (playButton === null) {
      playButton = buildPlayButton(att, resolvedUrl, wrap, video);
      video.after(playButton);
    }
  };
  const useLink = (link: FileLink): void => {
    source = "link";
    video.controls = true;
    video.src = link.src;
  };
  const recoverLink = (): void => {
    // A decode failure on a link that delivered bytes is the clip, not the link.
    if (video.error?.code === MEDIA_ERR_DECODE) {
      unplayable();
      return;
    }
    if (relinking) return;
    // A 403 (expired or voided link) and an undecodable clip both surface as
    // an unsupported-source error. Replace the link once before concluding;
    // after that the blob path decides, which can tell the two apart.
    if (Date.now() - lastRelinkAt < VIDEO_RELINK_COOLDOWN_MS) {
      useBlobPath();
      return;
    }
    lastRelinkAt = Date.now();
    relinking = true;
    resumeAt = video.currentTime;
    resumePlaying = !video.paused;
    void getFileLink(resolvedUrl, true).then((link) => {
      relinking = false;
      if (link === null) useBlobPath();
      else useLink(link);
    });
  };
  video.addEventListener("error", () => {
    if (source === "link") recoverLink();
    else unplayable();
  });
  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      sizeVideo(video, video.videoWidth, video.videoHeight);
      if (!videoDims.has(att.id) && videoDims.size >= VIDEO_DIMS_CAP) {
        const oldest = videoDims.keys().next().value;
        if (oldest !== undefined) videoDims.delete(oldest);
      }
      videoDims.set(att.id, [video.videoWidth, video.videoHeight]);
      if (resumeAt > 0) {
        video.currentTime = resumeAt;
        if (resumePlaying && wrap.isConnected) {
          void video.play().catch((err: unknown) => {
            log.debug("Media playback refused", { error: String(err) });
          });
        }
        resumeAt = 0;
      }
      return;
    }
    // No picture (audio-only, or a codec the engine lacks): keep playing as audio.
    const src = video.src;
    const wasPlaying = !video.paused;
    video.pause();
    video.removeAttribute("src");
    video.load();
    const row = renderAudioAttachment(att, resolvedUrl);
    const audio = row.querySelector("audio") as HTMLAudioElement;
    row.querySelector(".msg-media-play")?.remove();
    audio.hidden = false;
    audio.controls = true;
    audio.src = src;
    if (source === "link") watchAudioLink(att, resolvedUrl, row, audio);
    const note = createElement("div", { class: "msg-file-note", role: "status" });
    setText(note, messageStatusText("file.noPicture"));
    row.querySelector(".msg-file-meta")?.appendChild(note);
    swapKeepingFocus(wrap, row);
    if (wasPlaying && row.isConnected) {
      void audio.play().catch((err: unknown) => {
        log.debug("Media playback refused", { error: String(err) });
      });
    }
  });
  wrap.appendChild(video);

  const overlay = createElement("div", { class: "msg-media-overlay" });
  overlay.appendChild(buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(overlay);

  // Mint on render, not on play: the link is what lets the engine fetch the
  // first frame. The play button appears only if there is no link to stream.
  void getFileLink(resolvedUrl).then((link) => {
    if (link === null) useBlobPath();
    else useLink(link);
  });

  return wrap;
}

/** Inline <audio> player: a compact row carrying the player plus the same
 *  filename / size / download affordances as the file chip. */
function renderAudioAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-file msg-audio" });
  const inner = createElement("div", { class: "msg-file-inner" });

  const info = buildFileMeta(att, resolvedUrl);
  const audio = createElement("audio", { preload: "metadata" });
  audio.hidden = true;
  audio.setAttribute("aria-label", att.filename);
  appendChildren(info, buildPlayButton(att, resolvedUrl, wrap, audio), audio);

  appendChildren(inner, info, buildDownloadButton(att, resolvedUrl));
  wrap.appendChild(inner);

  return wrap;
}

/** The generic download chip: icon, filename, size and download button. */
function renderFileChip(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-file" });
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" });
  icon.appendChild(createIcon("file-text", 20));
  appendChildren(
    inner,
    icon,
    buildFileMeta(att, resolvedUrl),
    buildDownloadButton(att, resolvedUrl),
  );
  wrap.appendChild(inner);
  return wrap;
}

/** The file chip an image becomes when it cannot be shown, saying so. */
function renderUnshownImage(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const chip = renderFileChip(att, resolvedUrl);
  const note = createElement("div", { class: "msg-file-note", role: "status" });
  setText(note, messageStatusText("file.imageFailed"));
  chip.querySelector(".msg-file-meta")?.appendChild(note);
  return chip;
}

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
  if (isImageMime(att.mime) && inlineable) {
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
      img.setAttribute(
        "aria-label",
        messageStatusText("file.openImage", { filename: att.filename }),
      );
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
  if (inlineable && isServerUrl(resolvedUrl) && isTextPreviewable(att)) {
    return renderTextPreview(att, resolvedUrl, textPreviewDeps);
  }
  return renderFileChip(att, resolvedUrl);
}
