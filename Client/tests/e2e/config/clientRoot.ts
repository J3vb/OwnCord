import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright resolves relative paths in a config against that config's own
// folder, and the variant configs here spread each other. Absolute paths keep
// every config pointing at the same Client/ tree wherever it sits.
export const clientRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function fromClientRoot(path: string): string {
  return join(clientRoot, path);
}
