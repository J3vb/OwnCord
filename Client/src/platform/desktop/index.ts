// The desktop platform implementation. Empty for now — B7-4 and B7-5 fill in
// one capability at a time, moving call sites out of `src/lib` as each lands.
// Feature code must not import from here yet: nothing outside this milestone
// consumes `desktop/index.ts` until its first capability moves.
import type { Platform } from "../contracts";

export const desktop: Partial<Platform> = {};
