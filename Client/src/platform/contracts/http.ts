/**
 * The HTTP fetch capability every native-dependent REST caller uses today
 * (`lib/api.ts`, `lib/profiles.ts`, `message-list/{attachments,embeds,media}.ts`).
 *
 * Mirrors the Web-standard `fetch` signature: the native HTTP plugin already
 * implements it, and a browser adapter needs no translation at all — this is
 * the one contract where the host-neutral shape and the native shape are the
 * same shape.
 *
 * No-seam: every caller invokes the native HTTP plugin directly today, so
 * there is no exported function to bind a legacy suite against — a suite
 * over the mocked plugin would only test the mock. The suite lands with the
 * seam in B7-4.
 */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
