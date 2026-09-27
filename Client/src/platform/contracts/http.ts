/**
 * Byte progress for one in-flight upload, correlated by `id`. `total` is the
 * request body's declared length; `sent` is how many bytes of it the native
 * transport has read from the webview so far.
 */
export interface UploadProgress {
  readonly id: string;
  readonly sent: number;
  readonly total: number;
}

/**
 * The HTTP fetch capability every native-dependent REST caller uses today
 * (`lib/api.ts`, `lib/profiles.ts`, `message-list/{attachments,embeds,media}.ts`).
 *
 * Mirrors the Web-standard `fetch` signature: the native HTTP plugin already
 * implements it, and a browser adapter needs no translation at all — this is
 * the one contract where the host-neutral shape and the native shape are the
 * same shape.
 *
 * `onUploadProgress` is the one addition: the webview never sees the upload
 * bytes (the plugin buffers the whole body before the native client sends it),
 * so the native transport reports them out of band. An adapter with no such
 * channel returns an inert unsubscribe.
 *
 * No-seam: every caller invokes the native HTTP plugin directly today, so
 * there is no exported function to bind a legacy suite against — a suite
 * over the mocked plugin would only test the mock. The suite lands with the
 * seam in B7-4.
 */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Subscribe to native upload byte progress. Returns the unsubscribe. */
  onUploadProgress(handler: (progress: UploadProgress) => void): () => void;
}
