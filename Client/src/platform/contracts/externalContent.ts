/**
 * The external-content broker (B7-16): the only way renderer code reaches
 * content a message author or a fetched page named — link previews, oEmbed
 * titles, and every external image.
 *
 * Deliberately not an HTTP client (docs/trust-model.md, C-09 clause 1). The
 * native broker parses the URL, resolves and classifies every address, follows
 * redirects by hand, and bounds time, bytes, type and concurrency; what comes
 * back is a typed minimum (clause 7). No status, header or body crosses this
 * seam, and a preview's image is an opaque handle rather than a remote URL the
 * renderer could load itself behind the broker's back.
 *
 * Every call names a cache `partition` — the server the content is being shown
 * for, plus the renderer's cache epoch — so one server's previews are never
 * served to another, and a teardown makes the previous partition unreachable.
 */

/** Why the broker refused or could not complete a request. */
export type ExternalContentFailure =
  /** The URL, its scheme or port, or any resolved address is off-policy. */
  | "blocked-destination"
  /** More redirects than the broker follows by hand. */
  | "too-many-redirects"
  /** The response outgrew the per-fetch ceiling or the aggregate byte budget. */
  | "oversized"
  /** The response is not a type the broker hands to the renderer. */
  | "wrong-type"
  /** The image handle is not (or no longer) known in this partition; a fresh
   *  `preview()` mints a new one. */
  | "expired-handle"
  /** Network, TLS, status or deadline failure, or no native host. */
  | "unavailable";

/** A broker answer: the value, or the failure class that replaced it. */
export type ExternalContentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ExternalContentFailure };

/** An image the broker has already vetted, named without its URL. */
export type ExternalImageHandle = string & { readonly __externalImageHandle: unique symbol };

/** The typed minimum a link preview (or an oEmbed document) reduces to. */
export interface ExternalPreview {
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
  /** The preview image, fetchable only through `image()`. */
  readonly image: ExternalImageHandle | null;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

/** What `image()` accepts: a handle from `preview()`, or a URL the caller
 *  already holds (a YouTube thumbnail, an inline image, a GIF). */
export type ExternalImageSource =
  { readonly handle: ExternalImageHandle } | { readonly url: string };

export interface ExternalContentBroker {
  /** Fetch `url` and reduce it to its preview metadata (Open Graph for HTML,
   *  the title for an oEmbed JSON document). */
  preview(partition: string, url: string): Promise<ExternalContentResult<ExternalPreview>>;
  /** Fetch one vetted image and hand back its bytes. */
  image(partition: string, source: ExternalImageSource): Promise<ExternalContentResult<Blob>>;
}
