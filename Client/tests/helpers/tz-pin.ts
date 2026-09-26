/**
 * Probe and restore for `process.env.TZ` pins, for the regression blocks that
 * can only be written in a specific zone (OC-0315's east-of-UTC replay gate,
 * the DST day boundaries in renderers).
 *
 * `process.env.TZ = ...` only reaches Date's local-time engine on a process
 * main thread. In a worker-thread pool the assignment succeeds and Date
 * ignores it, so a block written for a pinned zone silently measures the
 * host's zone instead. Both blocks used to answer that with a bare
 * `describe.skipIf`, which meant the pool could evaporate a regression test
 * and tell nobody. `vitest.config.ts` now pins `pool: "forks"`, and this
 * throws when the pin is not honored anyway.
 *
 * The one sanctioned exception is `OC_ALLOW_UNPINNED_TZ=1`, set by
 * `stryker.config.mjs`: Stryker's vitest runner hard-codes `pool: 'threads'`
 * (`@stryker-mutator/vitest-runner`, `#getVitestPoolConfig`), so a mutation
 * run cannot honor a TZ pin at all and would otherwise be unable to start.
 * There, and only there, the caller may skip.
 */

/**
 * The host's zone, read before anything in the suite has pinned one. Needed
 * because `delete process.env.TZ` does NOT restore Date: Node resets V8's
 * date cache from the `TZ` **setter**, not from the deleter, so a pin that is
 * cleaned up by deletion leaves the whole forked worker stuck in the pinned
 * zone — and vitest reuses a worker across test files.
 */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Put `process.env.TZ` back the way it was, and make Date agree.
 *
 * @param original The value of `process.env.TZ` captured before pinning.
 */
export function restoreTZ(original: string | undefined): void {
  // Assign first — that is the operation that resets the date cache — then
  // remove the variable if it was not set to begin with. Date keeps the host
  // zone; the environment keeps its original shape.
  process.env.TZ = original ?? HOST_ZONE;
  if (original === undefined) {
    delete process.env.TZ;
  }
}

/**
 * Pin `zone`, run `verify()`, restore.
 *
 * @param zone   IANA zone to pin, e.g. "Asia/Tokyo".
 * @param verify Runs with the zone pinned; true when Date observed it.
 * @returns true when the pin holds; false only under the sanctioned opt-out.
 * @throws when the pin is not honored and the opt-out is not set.
 */
export function tzPinHonored(zone: string, verify: () => boolean): boolean {
  const original = process.env.TZ;
  process.env.TZ = zone;
  let honored: boolean;
  try {
    honored = verify();
  } finally {
    restoreTZ(original);
  }
  if (honored) return true;
  if (process.env.OC_ALLOW_UNPINNED_TZ === "1") return false;
  throw new Error(
    `TZ pin "${zone}" was not honored: Date still reports the host zone, so the ` +
      `regression block guarded by this probe would measure nothing. This means ` +
      `the suite is running in a worker-thread pool — vitest.config.ts pins ` +
      `pool: "forks" for exactly this reason, so something overrode it. Set ` +
      `OC_ALLOW_UNPINNED_TZ=1 only if that override is deliberate and the block ` +
      `is genuinely unrunnable there (Stryker does).`,
  );
}
