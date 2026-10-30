import { describe, it, expect } from "vitest";
// Vite's `?raw` suffix inlines the file's source text as a string (see
// src/vite-env.d.ts's `vite/client` types) — used below for a structural
// bundle-hygiene assertion, without pulling in node:fs.
import dispatcherSource from "../../../src/lib/dispatcher.ts?raw";

describe("bundle hygiene", () => {
  // screenShare.ts has VALUE imports from livekit-client (~1.3 MB) at module
  // scope. dispatcher.ts is imported statically from main.ts, so a top-level
  // `import ... from "@lib/voice/screenShare"` here drags the whole library into
  // the startup bundle — every other voice call site in this file already
  // loads its module lazily (see the livekitSession() helper), and
  // screenShare.ts's one export used here (rollbackPendingVideo) must follow
  // the same idiom instead of a static import.
  it("does not statically import screenShare — dynamic import only", () => {
    const staticImport = /^\s*import\s[^;]*from\s+["']@lib\/screenShare["']/m;
    expect(staticImport.test(dispatcherSource)).toBe(false);
  });
});
