/**
 * Navigation generation guard — protects async page mounts against the
 * destroy-before-mount race. A render that awaits a dynamic import captures
 * a generation via begin(); when the import resolves it asks the returned
 * predicate whether it is still the latest navigation, and discards the
 * mount if a newer navigation superseded it.
 */

export interface NavigationGuard {
  /** Start a new navigation. Returns a predicate that reports whether this
   *  navigation is still the latest one. */
  begin(): () => boolean;
}

export function createNavigationGuard(): NavigationGuard {
  let generation = 0;
  return {
    begin(): () => boolean {
      const started = ++generation;
      return () => started === generation;
    },
  };
}
