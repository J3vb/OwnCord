package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
)

// Phase names for the failures runUpgrade raises itself (phases 1, 3, 5, 7 and
// 8), kept together because a CI failure is grepped by them. A drain or boot
// fails under the phase string the target builds ("drain old", "drain new",
// "new boot", "old boot"), so grepping for "phase 2" finds nothing, and those
// labels are not unique: "old boot" is phase 1 and phase 7's restart, "drain
// old" is phase 2 and the final drain closing rollBack. The completion line
// printed above a failure says which.
const (
	phasePopulate = "phase 1 (populate)"
	phaseDrainOld = "phase 2 (drain old)"
	phaseArchive  = "phase 3 (archive)"
	phaseUpgrade  = "phase 4 (upgrade)"
	phaseVerify   = "phase 5 (verify)"
	phaseDrainNew = "phase 6 (drain new)"
	phaseRestore  = "phase 7 (restore)"
	phaseRollback = "phase 8 (rolled back)"
)

// runUpgrade rehearses an upgrade from oldRef to newRef and the rollback out of
// it, against whichever deployment mode the flags selected.
//
// Phases 2 and 3 must not be reordered: the archive copies data/chatserver.db
// as a file, and docs/deployment.md says never to copy the database out from
// under a running server (a hot copy of SQLite and its WAL is not
// consistent). Phases 6 and 7 are the same pairing in reverse.
//
// The rollback is restore-then-downgrade. Migrations are forward-only, so
// there is no schema step to undo and this harness must never grow one.
func runUpgrade(oldRef, newRef string, useDocker bool) error {
	t, err := newTarget(oldRef, newRef, useDocker)
	if err != nil {
		return err
	}
	defer t.cleanup()

	// The archive lives outside the install directory: a copy kept inside the
	// directory being upgraded is eaten with the install.
	archiveDir, err := os.MkdirTemp("", "owncord-upgrade-archive-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(archiveDir) }()

	fmt.Println("upgrade rehearsal:", oldRef, "->", newRef)
	fmt.Println("archive directory:", archiveDir)

	if err := t.start("old"); err != nil {
		return err
	}
	serverLog, err := t.log()
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	f, err := installFixture(t.baseURL(), serverLog)
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	dir, err := t.installDir()
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	before, err := captureState(dir, t.baseURL(), f.token, f.attachmentID)
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	// captureState cannot check itself (the post-upgrade capture may have lost
	// things, which is how compare names them), so the first capture is
	// anchored to what the fixture created; otherwise an empty capture makes
	// every "nothing was lost" assertion true over nothing.
	if err := f.anchor(before); err != nil {
		return t.annotate(phasePopulate, err)
	}
	fmt.Printf("%s: the old install is populated and captured, version %s\n", phasePopulate, before.version)

	// drain() asserts the healthcheck stops passing.
	if err := t.drain(); err != nil {
		return err
	}
	fmt.Println(phaseDrainOld + ": the old server drained and is no longer serving")

	// archive() returning nil is the whole check here, not a verified backup:
	// phase 8 verifies the contents by restoring this directory and comparing
	// it against the capture above.
	//
	// On the standalone leg a failure here carries no log tail: phase 2 drained
	// the server and annotate has no log once t.running is nil (likewise phases
	// 6 and 7). The container leg keeps its log across a drain until restore()
	// removes the container, so there the gap is phase 7 alone.
	if err := t.archive(archiveDir); err != nil {
		return t.annotate(phaseArchive, err)
	}
	fmt.Println(phaseArchive + ": copied data/ and config.yaml out of the stopped install")

	// Only the binary changes: no directory is moved, no file touched, no
	// configuration rewritten, as in the upgrade an owner performs.
	if err := t.start("new"); err != nil {
		return err
	}
	fmt.Println(phaseUpgrade + ": the new version booted on the untouched install directory")

	// A failed installDir() is a failed capture, not a missing path: reading
	// past it would compare phase 1's bytes with themselves.
	dir, err = t.installDir()
	if err != nil {
		return t.annotate(phaseVerify, err)
	}
	after, err := captureState(dir, t.baseURL(), f.token, f.attachmentID)
	if err != nil {
		return t.annotate(phaseVerify, err)
	}
	if err := upgraded(f, before, after); err != nil {
		return t.annotate(phaseVerify, err)
	}
	if err := sessionSurvived(t.baseURL(), f); err != nil {
		return t.annotate(phaseVerify, err)
	}
	fmt.Printf("%s: %s -> %s, nothing lost, the pre-upgrade session still works\n",
		phaseVerify, before.version, after.version)

	return rollBack(t, f, before, after, archiveDir)
}

// rollBack is phases 6-8 and the final drain. It takes the pre-upgrade capture
// phase 1 anchored, since "the rollback worked" is defined against that.
func rollBack(t target, f fixture, before, after state, archiveDir string) error {
	// Phase 7 replaces data/ as files, so the phase 3 precondition applies in
	// reverse: doing that under a running server deletes the database from
	// underneath it.
	if err := t.drain(); err != nil {
		return err
	}
	fmt.Println(phaseDrainNew + ": the new server drained and is no longer serving")

	// restore() removes the live data directory before copying the archive
	// over it, deliberately: the new version wrote files the archive has never
	// heard of (data/erasure.key, data/push_vapid.key, data/erasure/), and a
	// merge would leave them behind, a state no version has been in. An
	// owner's rollback is "put the copy back".
	//
	// The failure arrives without a log tail on either leg (see phase 3):
	// restore() removes the container as its first act.
	if err := t.restore(archiveDir); err != nil {
		return t.annotate(phaseRestore, err)
	}
	if err := t.start("old"); err != nil {
		return err
	}
	fmt.Println(phaseRestore + ": the archive is back in place and the old version booted on it")

	dir, err := t.installDir()
	if err != nil {
		return t.annotate(phaseRollback, err)
	}
	rolledBack, err := captureState(dir, t.baseURL(), f.token, f.attachmentID)
	if err != nil {
		return t.annotate(phaseRollback, err)
	}
	if err := restored(before, rolledBack); err != nil {
		return t.annotate(phaseRollback, err)
	}
	// The pre-upgrade token, carried through both version swaps, still
	// authenticates as the owner against the old binary and restored database.
	if err := sessionSurvived(t.baseURL(), f); err != nil {
		return t.annotate(phaseRollback, err)
	}
	fmt.Printf("%s: %s -> %s, everything the pre-upgrade capture recorded is back, the pre-upgrade session still works\n",
		phaseRollback, after.version, rolledBack.version)

	// The last server is drained, not killed by t.cleanup(): the old binary has
	// to stop cleanly after running on the restored install.
	if err := t.drain(); err != nil {
		return err
	}
	return nil
}

// restored is the phase-8 mirror of upgraded: the same two captures with the
// opposite version expectation. It is a separate function rather than a
// direction flag because only the version assertion differs. compare() prints
// its additions line. The capture re-fetched the pre-upgrade attachment
// through the rolled-back server, so a rollback that restored the file but can
// no longer serve it fails here too.
func restored(before, rolledBack state) error {
	problems := make([]error, 0, 2)

	// Catches a rollback that did not happen: every other check passes with the
	// new binary still serving, since the data directory really is the
	// pre-upgrade one. Only the reported version tells that apart.
	if before.version != rolledBack.version {
		problems = append(problems, fmt.Errorf(
			"the reported version is %s after the rollback, want the pre-upgrade %s: the old binary is not what is serving",
			rolledBack.version, before.version))
	}
	// Subset, not equality (see compare): what the HEAD run added and the
	// restore removed is absent from this side, which is a correct rollback.
	if err := compare(before, rolledBack); err != nil {
		problems = append(problems, err)
	}
	return errors.Join(problems...)
}

// upgraded asserts every phase-5 promise answerable from the two captures.
func upgraded(f fixture, before, after state) error {
	problems := make([]error, 0, 3)

	// Catches an upgrade that did not happen: if the swap silently kept the old
	// binary (stale process on 8443, failed copy, wrong path) every other
	// assertion passes, because nothing about the install changed.
	if before.version == after.version {
		problems = append(problems, fmt.Errorf(
			"the reported version is still %s after the upgrade: the new binary is not what is serving",
			after.version))
	}
	if err := compare(before, after); err != nil {
		problems = append(problems, err)
	}
	// The database was not recreated. sessionSurvived carries most of this
	// (a recreated database has no session or owner row); this adds the
	// pre-upgrade backup, a file the upgrade could sweep while leaving a
	// working database, and the rollback recipe is worthless without it.
	if !slices.Contains(after.backups, f.backupName) {
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade backup %s is not listed after the upgrade, only %v", f.backupName, after.backups))
	}
	return errors.Join(problems...)
}

// sessionSurvived is the credential assertion with teeth: the session open
// before the upgrade is still authenticated as the same owner. A fresh login
// would pass against a database the upgrade had recreated.
func sessionSurvived(baseURL string, f fixture) error {
	var me struct {
		Username string `json:"username"`
	}
	if err := request(http.MethodGet, baseURL+"/api/v1/auth/me", f.token, "", nil, http.StatusOK, &me); err != nil {
		return fmt.Errorf("the pre-upgrade session no longer authenticates: %w", err)
	}
	if me.Username != fixtureUser {
		return fmt.Errorf("the pre-upgrade session authenticates as %q, want the fixture owner %q", me.Username, fixtureUser)
	}
	return nil
}
