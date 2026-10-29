/// <reference types="vite/client" />

/** Build constant: true only in the web build (`vite.config.web.ts`), where the
 *  browser platform replaces the desktop one. Defined `false` everywhere else. */
declare const __OWNCORD_WEB__: boolean;

interface ImportMetaEnv {
  /** The app version, defined only in the web build (`vite.config.web.ts`):
   *  a page has no native host to ask. */
  readonly OWNCORD_APP_VERSION?: string;
}

declare module "virtual:owncord-changelog" {
  /** The repository's CHANGELOG.md (vite.config.ts, `changelogModule`). */
  const text: string;
  export default text;
}
