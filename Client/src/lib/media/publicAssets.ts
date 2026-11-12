// Where the files in `Client/public/` (the audio worklets, the speech worker,
// its model and rnnoise.wasm) are served from. The desktop build leaves them at
// the dist root, as Vite does. The web build copies them under
// `assets/public-<content hash>/` (`vite.config.web.ts`) because the server
// portal serves only `/` and `/assets/*`, as immutable: the hash moves the
// folder whenever any file changes, so a browser never keeps a stale copy.
// `__OWNCORD_WEB__` is a build constant, so the unused branch is folded away.
export const PUBLIC_BASE: string = __OWNCORD_WEB__
  ? (import.meta.env.OWNCORD_PUBLIC_BASE ?? "/assets/")
  : "/";

/** The URL of a `public/` file, e.g. `publicAssetUrl("vad-worklet.js")`. */
export function publicAssetUrl(name: string): string {
  return `${PUBLIC_BASE}${name}`;
}
