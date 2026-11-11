/**
 * The inline video player and the audio row a picture-less clip becomes.
 * A leaf like attachments.ts: it never imports a sibling renderer.
 */

import { createElement, setText } from "@lib/dom";
import type { Attachment } from "@lib/types";
import { messageStatusText } from "../../../i18n/messageStatus";
import { type FileLink, getFileLink, VIDEO_DIMS_CAP, videoDims } from "./attachmentCache";
import { log } from "./attachmentUrls";
import {
  buildDownloadButton,
  buildPlayButton,
  renderAudioAttachment,
  renderFileChip,
  swapKeepingFocus,
} from "./attachmentFiles";

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
export function renderVideoAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
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
