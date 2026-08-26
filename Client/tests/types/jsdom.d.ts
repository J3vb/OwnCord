// jsdom ships no type declarations and @types/jsdom is not a dependency of
// this project. Declare the surface the tests/contract/ admin-SPA test
// actually uses, following the same pattern as src/types/jitsi-rnnoise.d.ts.
// (jsdom itself stays a required dependency regardless: vitest.config.ts
// sets environment: "jsdom" for the whole suite.)
declare module "jsdom" {
  export interface JSDOMOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    beforeParse?: (window: Window & typeof globalThis) => void;
  }

  export class JSDOM {
    constructor(html: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis & { close(): void };
  }
}
