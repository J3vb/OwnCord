/**
 * Previous/next arrows between a message's images in the image viewer (3A-10c).
 *
 * Loaded lazily by `openImageLightbox` (attachments.ts) only when the clicked
 * message has two or more images, so a single-image open never pays for it. It
 * drives the open viewer through a small handle and holds no state of its own
 * beyond the position: the viewer's `current` image stays the one source that
 * Download, the image menu and eviction recovery read.
 */

import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { mediaControlsText } from "../../i18n/mediaControls";
import type { LightboxGallery, LightboxHandle } from "./attachments";

const log = createLogger("lightbox-gallery");

function arrow(
  cls: string,
  label: string,
  icon: "chevron-left" | "chevron-right",
): HTMLButtonElement {
  const btn = createElement("button", {
    class: cls,
    type: "button",
    "aria-label": label,
    title: label,
  });
  btn.appendChild(createIcon(icon, 24));
  return btn;
}

/** Add the arrows, the "n of m" counter, key stepping and the deletion watch
 *  to an open viewer. Everything is released with the viewer's `signal`. */
export function attachLightboxGallery(gallery: LightboxGallery, handle: LightboxHandle): void {
  const { items, isGone, watch, row } = gallery;
  const { overlay, img, controls, signal, fetchImageAsObjectUrl, thumbnailUrl, shownImageUrl } =
    handle;
  const total = items.length;
  if (signal.aborted || total < 2) return;

  const closeForDeletion = (): void => {
    handle.close();
    // The clicked image went with the row's re-render: land on the tombstone.
    const target = row?.();
    if (target instanceof HTMLElement && target.isConnected) {
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus();
    } else {
      document.body.focus();
    }
  };
  if (isGone?.() === true) {
    closeForDeletion();
    return;
  }

  let index = gallery.index;
  // Bumped by every show(): a fetch that finishes for an older step is dropped
  // (the generation pattern ws.ts uses).
  let step = 0;

  const counter = createElement("div", { class: "image-lightbox-counter", role: "status" });
  const prevBtn = arrow("image-lightbox-prev", mediaControlsText("lightbox.prev"), "chevron-left");
  const nextBtn = arrow("image-lightbox-next", mediaControlsText("lightbox.next"), "chevron-right");

  const label = (): void => {
    setText(counter, mediaControlsText("lightbox.position", { index: index + 1, total }));
  };

  const show = (to: number, direction: 1 | -1): void => {
    index = ((to % total) + total) % total;
    const mine = ++step;
    const item = items[index];
    if (item === undefined) return;
    handle.resetView();
    handle.closeMenu();
    const shown = shownImageUrl(item.url, item.mime);
    handle.setCurrent({ external: { url: item.url }, alt: item.filename, shown });
    overlay.setAttribute("aria-label", item.filename);
    img.alt = item.filename;
    label();

    // The preview first, then the full file, as the first image loads.
    let loaded = false;
    // Both fetches failed: drop the previous picture rather than leave it
    // under the new image's counter, alt and label.
    const failed = (): void => {
      img.removeAttribute("src");
      showToast(mediaControlsText("lightbox.openFailed"), "error");
    };
    void fetchImageAsObjectUrl(thumbnailUrl(item.url, item.mime))
      .then((preview) => {
        if (mine === step && preview !== null) {
          img.src = preview;
          loaded = true;
        }
        return fetchImageAsObjectUrl(shown);
      })
      .then((full) => {
        if (mine !== step) return;
        if (full === null) {
          if (!loaded) failed();
          return;
        }
        if (img.src !== full) img.src = full;
      })
      .catch((err: unknown) => {
        log.warn("Lightbox image failed to load", { error: String(err) });
        if (mine === step && !loaded) failed();
      });

    // The next image in the direction of travel, so the next step is instant.
    const ahead = items[(((index + direction) % total) + total) % total];
    if (ahead !== undefined) void fetchImageAsObjectUrl(shownImageUrl(ahead.url, ahead.mime));
  };

  for (const [btn, direction] of [
    [prevBtn, -1],
    [nextBtn, 1],
  ] as const) {
    btn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        btn.focus();
        show(index + direction, direction);
      },
      { signal },
    );
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // An open image menu owns the keys.
      if (handle.isImageMenuOpen()) return;
      e.preventDefault();
      const direction = e.key === "ArrowRight" ? 1 : -1;
      show(index + direction, direction);
    },
    { signal },
  );

  label();
  overlay.append(counter, prevBtn, nextBtn);
  controls.unshift(prevBtn, nextBtn);

  if (watch !== undefined) {
    const unwatch = watch(closeForDeletion);
    signal.addEventListener("abort", unwatch, { once: true });
  }
}
