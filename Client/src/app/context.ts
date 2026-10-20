// Shared types for the composition layer (src/app/). Types only: this module
// has no runtime code, so importing it costs nothing at startup.

/**
 * The two top-level pages. The router (`router.ts`) keeps the mounted page
 * *component* under its own name; this is the page id.
 */
export type PageId = "connect" | "main";
