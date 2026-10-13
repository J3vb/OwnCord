/// <reference types="vite/client" />

declare module "virtual:owncord-changelog" {
  /** The repository's CHANGELOG.md (vite.config.ts, `changelogModule`). */
  const text: string;
  export default text;
}
