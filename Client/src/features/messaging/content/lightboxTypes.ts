/** The shapes the image lightbox and its lazy gallery module share. */

import type { ExternalImageSource } from "../../../platform/contracts/externalContent";

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
