/**
 * The non-image attachment shapes: the download chip, the audio row and the
 * buttons they share. A leaf like attachments.ts: it imports the cache and
 * URL modules and the image viewer, never a sibling renderer.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { Attachment } from "@lib/types";
import { messageStatusText } from "../../../i18n/messageStatus";
import { fetchMediaAsObjectUrl } from "./attachmentCache";
import { downloadFile } from "./imageViewer";
import { formatFileSize, log } from "./attachmentUrls";

/** The filename + size + download row shared by the audio player and the
 *  generic file chip. */
export function buildFileMeta(att: Attachment, resolvedUrl: string): HTMLDivElement {
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
export function buildDownloadButton(att: Attachment, resolvedUrl: string): HTMLButtonElement {
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
export function buildPlayButton(
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
export function swapKeepingFocus(wrap: HTMLElement, next: HTMLElement): void {
  const hadFocus = wrap.contains(document.activeElement);
  wrap.replaceWith(next);
  if (hadFocus) next.querySelector<HTMLElement>(".msg-file-download")?.focus();
}

/** Inline <audio> player: a compact row carrying the player plus the same
 *  filename / size / download affordances as the file chip. */
export function renderAudioAttachment(att: Attachment, resolvedUrl: string): HTMLDivElement {
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
export function renderFileChip(att: Attachment, resolvedUrl: string): HTMLDivElement {
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
export function renderUnshownImage(att: Attachment, resolvedUrl: string): HTMLDivElement {
  const chip = renderFileChip(att, resolvedUrl);
  const note = createElement("div", { class: "msg-file-note", role: "status" });
  setText(note, messageStatusText("file.imageFailed"));
  chip.querySelector(".msg-file-meta")?.appendChild(note);
  return chip;
}
