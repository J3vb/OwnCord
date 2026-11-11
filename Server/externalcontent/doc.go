// Package externalcontent is the server-side broker for link previews, oEmbed titles and outside
// images, fetched by the server so the viewer's browser never contacts a host a message author
// chose. It is the twin of the desktop broker (Client/src-tauri/src/external_content.rs) and keeps
// its limits, Open Graph precedence, opaque image handles and failure names
// (Client/src/platform/contracts/externalContent.ts).
//
// Every fetch goes through safefetch, the server's one outbound-content policy (docs/trust-model.md,
// the preview destination policy). The broker is mounted only when server.browser_client_enabled
// is on. State is in memory: a byte-weighted result cache shared by every viewer (public content,
// fetched without credentials) and a count-bounded handle table, each handle usable only by its user.
package externalcontent
