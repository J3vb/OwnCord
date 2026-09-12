package main

import "fmt"

// runUpgrade rehearses an upgrade from oldRef to newRef and the rollback back
// out of it, against whichever deployment mode the flags selected.
//
// The eight phases land in B6-8 Tasks 3 and 4. The target is built here so an
// unreadable -from or an unbuilt deployment leg is reported as itself rather
// than as a failure inside a phase.
func runUpgrade(oldRef, newRef string, useDocker bool) error {
	t, err := newTarget(oldRef, newRef, useDocker)
	if err != nil {
		return err
	}
	defer t.cleanup()

	return fmt.Errorf("the upgrade and rollback phases are not implemented yet (B6-8 Tasks 3-4): asked for %s -> %s", oldRef, newRef)
}
