/**
 * Right-click menu for chat images and the lightbox: Copy Image, Save Image
 * and, for an image with a public address, Copy Link and Open Link. The app
 * suppresses the webview's own context menu everywhere (main.ts), so without
 * this an image offers nothing on right-click.
 *
 * A leaf like attachments.ts: it imports no sibling renderer. attachments.ts
 * loads it lazily on the first right-click, so the menu and its copy stay out
 * of the chunks that carry attachments.ts.
 */

import { showContextMenu, type ContextMenuItem } from "@lib/context-menu";
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/toast";
import { desktop } from "../../platform/desktop";
import { imageMenuText } from "../../i18n/imageMenu";
import { copyThenToast } from "@lib/clipboard";

const log = createLogger("image-menu");

export interface ImageMenuTarget {
  /** The rendered image; its bytes are same-origin (blob: or data:), so it
   *  can be drawn to a canvas for the clipboard. */
  readonly img: HTMLImageElement;
  /** Public http(s) address, offered as Copy Link and Open Link. Null for a
   *  server attachment, whose address needs the session token to open. */
  readonly link: string | null;
  /** The full image's same-origin URL, when `img` shows a smaller preview
   *  (a server thumbnail); Copy Image copies this instead. */
  readonly full?: () => Promise<string | null>;
  /** Save the full image to a location the user picks. */
  readonly save: () => Promise<void>;
}

/** Above the lightbox (z-index 600), so the menu opens over it. */
const MENU_CLASS = "image-context-menu";

let menuOwner: Disposable | null = null;

/** Close the open image menu, if any (page teardown, lightbox close). */
export function closeImageMenu(): void {
  menuOwner?.destroy();
  menuOwner = null;
}

/** Re-encode the image as PNG, the one image type every clipboard takes.
 *  An animated GIF copies its current frame. */
function imageToPng(img: HTMLImageElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null || canvas.width === 0 || canvas.height === 0) {
      // i18n-exempt: internal error, logged by the caller, never rendered
      reject(new Error("image not decodable"));
      return;
    }
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      // i18n-exempt: internal error, logged by the caller, never rendered
      if (blob === null) reject(new Error("PNG encode failed"));
      else resolve(blob);
    }, "image/png");
  });
}

/** Decode `src` off-screen so it can be drawn at full size. */
async function decodeImage(src: string | null): Promise<HTMLImageElement> {
  // i18n-exempt: internal error, logged by the caller, never rendered
  if (src === null) throw new Error("full image unavailable");
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

function copyImageFailed(err: unknown): void {
  log.warn("Copy image failed", { error: String(err) });
  showToast(imageMenuText("copyFailed"), "error");
}

function copyImage(target: ImageMenuTarget): void {
  if (typeof ClipboardItem === "undefined") {
    // i18n-exempt: internal log detail, never rendered
    copyImageFailed("no ClipboardItem");
    return;
  }
  // The write starts inside the click (WebKit wants the user gesture), with
  // the PNG still encoding behind the promise the ClipboardItem holds. An
  // encode failure surfaces through the write's own rejection.
  const source = target.full?.().then(decodeImage) ?? Promise.resolve(target.img);
  const png = source.then(imageToPng);
  png.catch(() => undefined);
  let write: Promise<void>;
  try {
    write = navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch (err) {
    copyImageFailed(err);
    return;
  }
  write.then(() => showToast(imageMenuText("copied"), "success"), copyImageFailed);
}

function copyLink(link: string): void {
  copyThenToast(link, imageMenuText("linkCopied"), imageMenuText("linkCopyFailed"));
}

function openLink(link: string): void {
  desktop.urlOpener.open(link).catch((err: unknown) => {
    log.warn("Open image link failed", { error: String(err) });
    showToast(imageMenuText("openFailed"), "error");
  });
}

function menuItems(target: ImageMenuTarget): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: imageMenuText("copy"),
      testId: "image-menu-copy",
      onClick: () => copyImage(target),
    },
  ];
  const { link } = target;
  if (link !== null) {
    items.push(
      {
        label: imageMenuText("copyLink"),
        testId: "image-menu-copy-link",
        onClick: () => copyLink(link),
      },
      {
        label: imageMenuText("openLink"),
        testId: "image-menu-open-link",
        onClick: () => openLink(link),
      },
    );
  }
  items.push({
    label: imageMenuText("save"),
    testId: "image-menu-save",
    onClick: () => void target.save(),
  });
  return items;
}

/**
 * Open the image menu for `target` at (x, y). `signal`, when given, closes the
 * menu with its owner (the lightbox). The right-click binding lives in
 * attachments.ts, which loads this module on first use.
 */
export function openImageMenu(
  x: number,
  y: number,
  target: ImageMenuTarget,
  signal?: AbortSignal,
): void {
  if (signal?.aborted === true || !target.img.isConnected) return;
  closeImageMenu();
  const owner = new Disposable();
  menuOwner = owner;
  signal?.addEventListener("abort", () => owner.destroy(), { once: true, signal: owner.signal });
  showContextMenu({ x, y, items: menuItems(target), signal: owner.signal, className: MENU_CLASS });
}

/** A filename for an image saved from `url`: its last path segment when that
 *  has an image extension, else "image" plus the extension of `mime`. */
export function imageFilename(url: string, mime: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    if (/\.(gif|png|jpe?g|webp|avif|bmp)$/i.test(name)) return name;
  } catch {
    // Not a parseable URL: fall through to the generic name.
  }
  const ext = /^image\/([a-z0-9+.-]+)/i.exec(mime)?.[1]?.replace("jpeg", "jpg") ?? "png";
  // i18n-exempt: a filename, not UI text
  return `image.${ext.replace(/\+.*$/, "")}`;
}

/** Save an image whose bytes are already in the webview (a broker blob: URL)
 *  through the native save dialog. */
export async function saveImageBytes(src: string, url: string): Promise<void> {
  try {
    const blob = await (await fetch(src)).blob();
    const path = await desktop.fileSaver.pickSaveLocation(imageFilename(url, blob.type));
    if (path === null) return;
    await desktop.fileSaver.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  } catch (err) {
    log.error("Save image failed", { error: String(err) });
    showToast(imageMenuText("saveFailed"), "error");
  }
}
