// Package externalcontent is the server-side external-content broker for the
// browser client: link previews, oEmbed titles and outside images, fetched
// by the server so the viewer's browser never contacts a host a message
// author chose. It is the server twin of the desktop broker
// (Client/src-tauri/src/external_content.rs) and keeps its contract: the
// same limits, the same Open Graph precedence, an opaque handle in place of
// a preview's image URL, and the same failure names
// (Client/src/platform/contracts/externalContent.ts).
//
// Every fetch goes through safefetch, so the destination policy is the
// server's one outbound-content policy (docs/trust-model.md, the preview
// destination policy): https on 443 only, every resolved address classified, redirects
// followed by hand, one deadline and byte ceilings per fetch.
//
// The broker is mounted only when the server hosts the browser client
// (server.browser_client_enabled); the desktop app keeps its own broker.
//
// State is in memory only: a byte-weighted result cache shared by every
// viewer (the content is public web content, fetched without credentials)
// and a count-bounded table of image handles, each usable only by the user
// it was minted for.
package externalcontent
