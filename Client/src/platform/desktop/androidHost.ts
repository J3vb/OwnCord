// The door to a host module only the Android app has (`./mobileAudioHost.ts`,
// `./callServiceHost.ts`, `./systemIdleHost.ts`). The registry is in the
// startup chunk of every build, so each of those members is a facade that
// loads its host side on first use, through here.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";

/** Returns a function that runs `use` on the module `load` imports, once it
 *  is in. One load carries every call, so they reach the host side in the
 *  order they were made. It does nothing outside the Android app and never
 *  throws: a module that cannot load is logged under `name` and tried again
 *  at the next call. */
export function androidHost<Host>(
  name: string,
  load: () => Promise<Host>,
): (use: (host: Host) => void) => void {
  const log = createLogger(name);
  let loading: Promise<Host> | null = null;
  return (use) => {
    if (!isAndroidHost()) return;
    loading ??= load();
    loading.then(use).catch((err: unknown) => {
      loading = null;
      log.warn("Android host side unavailable", err);
    });
  };
}
