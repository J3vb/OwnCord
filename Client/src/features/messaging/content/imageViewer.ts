/**
 * Image download, the image context menu and the lightbox viewer.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { closeOnBackdropClick } from "@lib/ui/modalFactory";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createZoomPan, PAN_MIN_SCALE, bindTouchZoom } from "@lib/ui/zoomPan";
import { showToast } from "@lib/ui/toast";
import { announceSaved } from "@lib/ui/savedNotice";
import { desktop } from "../../../platform/desktop";
import type { ExternalImageSource } from "../../../platform/contracts/externalContent";
import { mediaControlsText } from "../../../i18n/mediaControls";
import { messageStatusText } from "../../../i18n/messageStatus";
import { fileTransferText } from "../../../i18n/fileTransfer";
import type { ImageMenuTarget } from "../../../components/message-list/imageMenu";
import {
  fetchExternalImage,
  fetchImageAsObjectUrl,
  fetchServerFile,
  isExternalUrl,
  isServerUrl,
  recoverEvictedImage,
  shownImageUrl,
  thumbnailUrl,
} from "./attachmentCache";
import { log } from "./attachmentUrls";

/** One image of a message's lightbox sequence. `url` is the resolved server URL. */
export interface LightboxGalleryItem {
  readonly url: string;
  readonly filename: string;
  readonly mime: string;
}

/** The images of the clicked message, for the viewer's previous/next arrows. */
export interface LightboxGallery {
  readonly items: readonly LightboxGalleryItem[];
  readonly index: number;
  /** True once the message was deleted; checked when the viewer opens. */
  readonly isGone?: () => boolean;
  /** Calls `onGone` when the message is deleted; returns the unsubscribe. */
  readonly watch?: (onGone: () => void) => () => void;
  /** The message's row, for focus when the viewer closes over a deletion. */
  readonly row?: () => Element | null;
}

/** What the viewer shows now: Download, Open original, the image menu and
 *  eviction recovery all read this at use time, never at bind time. */
export interface LightboxCurrent {
  readonly external: ExternalImageSource | undefined;
  readonly alt: string;
  /** The server URL shown in full when it is not `external`'s file: a HEIC or
   *  TIFF is shown through its JPEG preview, while Save keeps the original. */
  readonly shown?: string | undefined;
}

/** What the lazy gallery module drives (3A-10c). */
export interface LightboxHandle {
  readonly overlay: HTMLElement;
  readonly img: HTMLImageElement;
  /** Tab cycle, in order; the gallery puts its arrows first. */
  readonly controls: HTMLButtonElement[];
  readonly signal: AbortSignal;
  setCurrent(current: LightboxCurrent): void;
  /** Resets zoom and pan and ends a drag in progress. */
  resetView(): void;
  /** What a sideways swipe at 1x does: 1 is the next image, -1 the previous. */
  onSwipeStep(step: (direction: 1 | -1) => void): void;
  closeMenu(): void;
  /** True while the image menu is open; it owns the arrow keys. */
  isImageMenuOpen(): boolean;
  /** Passed in so the lazy gallery module imports only types from here. */
  fetchImageAsObjectUrl(url: string): Promise<string | null>;
  thumbnailUrl(fileUrl: string, mime: string): string;
  shownImageUrl(fileUrl: string, mime: string): string;
  close(): void;
}

/** What a file button does with the bytes: save them, or (where the host
 *  has a share sheet) hand them to another app. */
export type FileAction = "save" | "share";

function failedText(action: FileAction, filename: string): string {
  return action === "share"
    ? fileTransferText("shareFailed", { filename })
    : messageStatusText("file.downloadFailed", { filename });
}

/** Saves and shares in flight, by action and URL: a second tap while the first
 *  still runs does nothing, so a slow download is not saved twice. */
const inFlight = new Set<string>();

/** Download a file via Tauri HTTP plugin and save to disk with native dialog,
 *  or open the share sheet on it. `fs:allow-write-file` is statically scoped
 *  to `$APPLOG` (nothing covers app data); the save dialog grants the one path
 *  the user chose at runtime, so the dialog itself is the boundary for the
 *  download. The Android app has no dialog: the host saves into shared
 *  storage and a toast says where. */
export async function downloadFile(
  url: string,
  filename: string,
  action: FileAction = "save",
): Promise<void> {
  const key = `${action} ${url}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    // The dialog opens before the fetch, so it answers the click at once.
    const filePath = action === "save" ? await desktop.fileSaver.pickSaveLocation(filename) : null;
    if (action === "save" && filePath === null) return; // User cancelled

    // Fetch file data — server downloads go through the cert-pinned HTTP proxy
    // with the session bearer token (the files endpoint requires auth).
    const res = await fetchServerFile(url);
    if (!res.ok) {
      log.error("Download failed", { filename, status: res.status });
      showToast(messageStatusText("file.downloadHttpFailed", { status: res.status }), "error");
      return;
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (filePath === null) await desktop.shareSheet.shareFile(filename, data);
    else announceSaved(await desktop.fileSaver.writeFile(filePath, data), filename);
  } catch (err) {
    log.error(action === "share" ? "Share failed" : "Download failed", {
      filename,
      error: String(err),
    });
    showToast(failedText(action, filename), "error");
  } finally {
    inFlight.delete(key);
  }
}

// -- Image menu ---------------------------------------------------------------

type ImageMenuModule = typeof import("../../../components/message-list/imageMenu");
/** Set once the lazy menu module has loaded, so teardown can close its menu. */
let imageMenuModule: ImageMenuModule | null = null;

function loadImageMenu(): Promise<ImageMenuModule> {
  return import("../../../components/message-list/imageMenu").then((m) => {
    imageMenuModule = m;
    return m;
  });
}

/** Save (or share) an image whose bytes are already in the webview. */
export function saveImageBytes(
  src: string,
  url: string,
  action: FileAction = "save",
): Promise<void> {
  return loadImageMenu().then((m) => m.saveImageBytes(src, url, action));
}

/**
 * Open the image menu (Copy Image, Copy Link, Open Link, Save Image) on
 * right-click of `target.img`, or on the Menu key / Shift+F10 when the image
 * has focus (they fire `contextmenu` with no pointer position). `signal`, when
 * given, closes the menu with its owner (the lightbox).
 */
export function bindImageMenu(target: ImageMenuTarget, signal?: AbortSignal): void {
  const { img } = target;
  img.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // A hidden image is still loading or refused: nothing to copy.
      if (img.hidden || !img.hasAttribute("src")) return;
      let { clientX: x, clientY: y } = e;
      if (x === 0 && y === 0) {
        const rect = img.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      loadImageMenu().then(
        (m) => m.openImageMenu(x, y, target, signal),
        (err: unknown) => log.warn("Image menu failed to load", { error: String(err) }),
      );
    },
    signal !== undefined ? { signal } : undefined,
  );
}

// -- Lightbox -----------------------------------------------------------------

/** A labelled Save or Share button of the Android app's lightbox bar. */
function barButton(
  bar: HTMLElement,
  label: string,
  icon: "download" | "share-2",
): HTMLButtonElement {
  const btn = createElement("button", { class: "image-lightbox-bar-btn", type: "button" });
  btn.append(createIcon(icon, 20), createElement("span", {}, label));
  bar.appendChild(btn);
  return btn;
}

// Store the cleanup function for the active lightbox so rapid reopens
// properly remove document-level listeners from the previous instance.
let activeLightboxClose: (() => void) | null = null;

/** Close the active lightbox, if any. Called on page teardown (logout, page
 *  swap) so an open overlay doesn't survive onto the next page with live
 *  document listeners and a revoked blob URL. */
export function closeActiveLightbox(): void {
  activeLightboxClose?.();
  imageMenuModule?.closeImageMenu();
}

/** Open a full-screen lightbox overlay with zoom and pan. */
export function openImageLightbox(
  src: string,
  alt: string,
  external?: ExternalImageSource,
  gallery?: LightboxGallery,
  /** The server URL to show in full when it is not `external`'s own file (a
   *  HEIC's JPEG preview); Download and Save still take `external`. */
  shownUrl?: string,
): void {
  // Close any existing lightbox (including its document listeners)
  if (activeLightboxClose !== null) {
    activeLightboxClose();
    activeLightboxClose = null;
  }

  // Focus moves into the lightbox on open and back to the opener on close;
  // captured before the overlay takes focus.
  const opener = document.activeElement;
  const overlay = createElement("div", { class: "image-lightbox" });
  // A modal surface: named so a screen reader announces it, and tabbable
  // itself so the Tab cycle never escapes to the page behind it.
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt);
  overlay.tabIndex = -1;

  const imgWrap = createElement("div", { class: "image-lightbox-wrap" });
  const img = createElement("img", { src, alt });
  // The image on show; a gallery step replaces it (3A-10c).
  let current: LightboxCurrent = { external, alt, shown: shownUrl };
  const sourceOf = (c: LightboxCurrent): string | null =>
    c.external !== undefined && "url" in c.external ? c.external.url : null;
  // Only a public address opens in the system browser; a server attachment's
  // address needs the session token, which the browser would not have.
  const originalOf = (c: LightboxCurrent): string | null => {
    const url = sourceOf(c);
    return url !== null && isExternalUrl(url) ? url : null;
  };
  if (external !== undefined) {
    recoverEvictedImage(
      img,
      () =>
        current.shown !== undefined ? { url: current.shown } : (current.external ?? { url: "" }),
      undefined,
      () => current,
    );
  }
  // `src` can be the server's thumbnail: show it at once, then the
  // full file. A server image shown in full is a memory-cache hit here.
  if (external !== undefined && "url" in external && isServerUrl(external.url)) {
    const opened = current;
    void fetchImageAsObjectUrl(shownUrl ?? external.url).then((full) => {
      // A gallery step since the open owns the picture now.
      if (current !== opened) return;
      if (full !== null && img.isConnected && img.src !== full) img.src = full;
    });
  }
  imgWrap.appendChild(img);
  overlay.appendChild(imgWrap);

  // Top-right toolbar: Close, Download and (external images only) Open
  // original, left to right with Close in the corner.
  const toolbar = createElement("div", { class: "image-lightbox-toolbar" });
  const lightboxButton = (
    cls: string,
    label: string,
    icon: "x" | "download" | "external-link",
  ): HTMLButtonElement => {
    const btn = createElement("button", {
      class: cls,
      type: "button",
      "aria-label": label,
      title: label,
    });
    btn.appendChild(createIcon(icon, 20));
    toolbar.appendChild(btn);
    return btn;
  };
  // In the Android app Save and Share sit under the image as labelled
  // buttons a thumb can hit; the toolbar keeps Close and Open original.
  const phoneBar = desktop.shareSheet.available
    ? createElement("div", { class: "image-lightbox-actions" })
    : null;
  const downloadBtn =
    phoneBar === null
      ? lightboxButton("image-lightbox-action", mediaControlsText("lightbox.download"), "download")
      : barButton(phoneBar, mediaControlsText("lightbox.save"), "download");
  const shareBtn =
    phoneBar === null ? null : barButton(phoneBar, mediaControlsText("lightbox.share"), "share-2");
  const openBtn =
    originalOf(current) === null
      ? null
      : lightboxButton(
          "image-lightbox-action",
          mediaControlsText("lightbox.openOriginal"),
          "external-link",
        );
  const closeBtn = lightboxButton("image-lightbox-close", mediaControlsText("lightbox.close"), "x");
  // DOM order is the visual order left to right (the phone bar under the
  // toolbar), and so the Tab order.
  const controls: HTMLButtonElement[] = [
    ...(phoneBar === null ? [downloadBtn] : []),
    ...(openBtn === null ? [] : [openBtn]),
    closeBtn,
    ...(shareBtn === null ? [] : [downloadBtn, shareBtn]),
  ];

  overlay.appendChild(toolbar);
  if (phoneBar !== null) overlay.appendChild(phoneBar);

  const view = createZoomPan({
    min: 0.5,
    max: 10,
    apply: (transform) => {
      img.style.transform = transform;
    },
    centre: () => {
      const rect = img.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    onDrag: (dragging) => overlay.classList.toggle("dragging", dragging),
  });

  function close(): void {
    view.cancelDrag();
    overlay.remove();
    disposable.destroy();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    if (activeLightboxClose === close) activeLightboxClose = null;
  }

  imgWrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.wheel(e);
  });

  img.addEventListener("mousedown", (e) => {
    // A right-click opens the image menu; only the primary button pans.
    if (e.button !== 0) return;
    e.preventDefault();
    view.press(e);
  });

  // A click toggles 3x towards the pointer; the end of a pan is no click.
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    if (view.movedSincePress(e.clientX, e.clientY)) return;
    if (view.scale > PAN_MIN_SCALE) view.reset();
    else view.zoomAt(3, e.clientX, e.clientY);
  });

  // Use a Disposable for cleanup of document-level listeners to prevent leaks
  const disposable = new Disposable();
  // Pinch and drag on a touch screen, where the page itself does not zoom.
  // At 1x a swipe up or down closes; a sideways one steps once the gallery
  // has loaded (a single image has nothing to step to).
  let swipeStep: ((direction: 1 | -1) => void) | null = null;
  bindTouchZoom(overlay, view, disposable.signal, {
    step: (direction) => swipeStep?.(direction),
    close,
  });

  // One path for the menu's Save Image and Share Image and the Download (or
  // Save and Share) buttons. It reads the current image once, at the click,
  // so a step cannot redirect it.
  const transfer = (action: FileAction): Promise<void> => {
    const c = current;
    const sourceUrl = sourceOf(c);
    const shown = img.src;
    if (sourceUrl !== null && isServerUrl(sourceUrl)) return downloadFile(sourceUrl, c.alt, action);
    if (sourceUrl === null) return saveImageBytes(shown, "", action);
    // The broker's bytes, not img.src: a lightbox opened from a frozen GIF
    // shows a one-frame preview.
    return fetchExternalImage({ url: sourceUrl }).then((bytes) =>
      saveImageBytes(bytes ?? shown, sourceUrl, action),
    );
  };
  bindImageMenu(
    {
      img,
      get link() {
        return originalOf(current);
      },
      // img may still show the thumbnail or a frozen GIF frame it opened with.
      get full() {
        const sourceUrl = current.shown ?? sourceOf(current);
        return sourceUrl === null
          ? undefined
          : isServerUrl(sourceUrl)
            ? () => fetchImageAsObjectUrl(sourceUrl)
            : () => fetchExternalImage({ url: sourceUrl });
      },
      save: () => transfer("save"),
      share: () => transfer("share"),
    },
    disposable.signal,
  );

  // aria-disabled, not disabled: a disabled button drops focus and with it the
  // Tab cycle, which keys off the focused control.
  const bindTransfer = (btn: HTMLButtonElement, action: FileAction): void => {
    let busy = false;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (busy) return;
      busy = true;
      const filename = current.alt;
      btn.setAttribute("aria-disabled", "true");
      transfer(action)
        .catch((err: unknown) => {
          log.error("Lightbox download failed", { filename, action, error: String(err) });
          showToast(failedText(action, filename), "error");
        })
        .finally(() => {
          busy = false;
          btn.removeAttribute("aria-disabled");
        });
    });
  };
  bindTransfer(downloadBtn, "save");
  if (shareBtn !== null) bindTransfer(shareBtn, "share");
  openBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const originalUrl = originalOf(current);
    if (originalUrl === null) return;
    desktop.urlOpener.open(originalUrl).catch((err: unknown) => {
      log.warn("Open original image failed", { error: String(err) });
      showToast(mediaControlsText("lightbox.openFailed"), "error");
    });
  });

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  closeOnBackdropClick(overlay, close, disposable.signal);

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && !isImeCommit(e)) close();
    // The Menu key / Shift+F10 open the image's menu from whichever toolbar
    // button has focus, centred on the image.
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }
    if (e.key === "Tab") {
      // Contain focus in the dialog: Tab cycles through its toolbar buttons.
      e.preventDefault();
      const at = controls.findIndex((c) => c === document.activeElement);
      const step = e.shiftKey ? -1 : 1;
      const next = at === -1 ? (e.shiftKey ? controls.length - 1 : 0) : at + step;
      controls[(next + controls.length) % controls.length]?.focus();
    }
    // Ctrl/Cmd with these keys zooms the whole app, not the image.
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === "+" || e.key === "=") view.setScale(view.scale * 1.3);
    if (e.key === "-") view.setScale(view.scale / 1.3);
    if (e.key === "0") view.reset();
  }
  document.addEventListener("keydown", onKey, { signal: disposable.signal });

  activeLightboxClose = close;
  document.body.appendChild(overlay);
  closeBtn.focus();

  // Two or more images: the arrows, counter and stepping load on demand, so a
  // single-image open never pays for them.
  if (gallery !== undefined && gallery.items.length > 1) {
    const handle: LightboxHandle = {
      overlay,
      img,
      controls,
      signal: disposable.signal,
      setCurrent: (next) => {
        current = next;
      },
      resetView: () => view.reset(),
      onSwipeStep: (step) => {
        swipeStep = step;
      },
      closeMenu: () => imageMenuModule?.closeImageMenu(),
      // The menu's own class (image-menu.ts MENU_CLASS): asked of the DOM so it
      // holds even before the lazy menu module has loaded.
      isImageMenuOpen: () => document.querySelector(".image-context-menu") !== null,
      fetchImageAsObjectUrl,
      thumbnailUrl,
      shownImageUrl,
      close,
    };
    import("../../../components/message-list/lightboxGallery").then(
      (m) => {
        if (!disposable.signal.aborted) m.attachLightboxGallery(gallery, handle);
      },
      (err: unknown) => log.warn("Lightbox gallery failed to load", { error: String(err) }),
    );
  }
}
