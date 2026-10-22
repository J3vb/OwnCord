// The browser external-content broker (6.13d): there is none. The native broker
// exists so a renderer never fetches a URL a message author named (C-09,
// docs/trust-model.md); a page's own `fetch` has none of its address
// classification, redirect, size or type bounds, so every request is refused
// as `unavailable` and nothing is fetched at all.
import type { ExternalContentBroker } from "../contracts/externalContent";

export const externalContent: ExternalContentBroker = {
  preview: async () => ({ ok: false, failure: "unavailable" }),
  image: async () => ({ ok: false, failure: "unavailable" }),
};
