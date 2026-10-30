// The browser platform's HTTP client: the page's own `fetch`. The page
// talks only to the server that served it, so a request needs no tunnel and
// no translation — the contract already has the Web-standard shape.
import type { HttpClient } from "../contracts/http";
import { inertUnsubscribe } from "./unavailable";

export const http: HttpClient = {
  // Read at call time and forwarded exactly as it arrived, so `fetch` runs
  // with the page as its receiver and a caller that passed no `init` gets
  // none invented for it.
  fetch: (url, ...init) => globalThis.fetch(url, ...init),
  // `fetch` reports no upload progress; callers fall back to an unfilled bar.
  onUploadProgress: inertUnsubscribe,
};
