package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
)

// Phase names for the failures runUpgrade raises itself — phases 1, 3, 5, 7
// and 8 — kept together because they are what a CI failure is grepped by.
//
// They are NOT what every phase prints. A drain or a boot fails under the
// phase string standaloneTarget builds for it, so phase 2 is labelled
// "drain old", phase 6 "drain new", phase 4 "new boot" and phase 7's restart
// "old boot": grepping a red log for "phase 2" or "phase 6" finds nothing.
// Each of those phases prints its own completion line instead, so the
// progression is readable on a green run.
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

// runUpgrade rehearses an upgrade from oldRef to newRef and the rollback back
// out of it, against whichever deployment mode the flags selected.
//
// The order of phases 2 and 3 is not arbitrary and must not be tidied: the
// archive copies data/chatserver.db as a file, and docs/deployment.md says in
// as many words never to copy the database out from under a running server —
// a hot copy of SQLite and its WAL is not a consistent snapshot. An owner
// stops the server before taking the pre-upgrade copy, so the rehearsal does
// too, and standaloneTarget.archive's own precondition says the same. Phases
// 6 and 7 are the same pairing in reverse and for the same reason.
//
// The rollback is restore-then-downgrade: put the archive back, then run the
// old binary. Migrations are forward-only, so there is no schema step to
// undo and this harness must never grow one — the archived database is
// simply the pre-upgrade database, and serving it again is the rollback.
func runUpgrade(oldRef, newRef string, useDocker bool) error {
	t, err := newTarget(oldRef, newRef, useDocker)
	if err != nil {
		return err
	}
	defer t.cleanup()

	// The archive lives outside the install directory on purpose. It is the
	// copy the docs will tell owners to take before upgrading, and a copy
	// kept inside the directory being upgraded is not one: whatever eats the
	// install eats the backup with it.
	archiveDir, err := os.MkdirTemp("", "owncord-upgrade-archive-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(archiveDir) }()

	fmt.Println("upgrade rehearsal:", oldRef, "->", newRef)
	fmt.Println("archive directory:", archiveDir)

	// --- Phase 1: install the old version and populate it -------------------
	if err := t.start("old"); err != nil {
		return err
	}
	f, err := installFixture(t.baseURL())
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	before, err := captureState(t.installDir(), t.baseURL(), f.token, f.attachmentID)
	if err != nil {
		return t.annotate(phasePopulate, err)
	}
	// captureState cannot check itself — the post-upgrade capture is allowed
	// to have lost things, which is how compare names them — so the first
	// capture is anchored to what the fixture actually created. Without this,
	// a capture that came back empty makes every "nothing was lost" assertion
	// below true over nothing at all.
	if err := f.anchor(before); err != nil {
		return t.annotate(phasePopulate, err)
	}
	fmt.Printf("%s: the old install is populated and captured, version %s\n", phasePopulate, before.version)

	// --- Phase 2: stop the old server ---------------------------------------
	// drain() asserts the healthcheck stops passing; it is not re-derived here.
	if err := t.drain(); err != nil {
		return err
	}
	fmt.Println(phaseDrainOld + ": the old server drained and is no longer serving")

	// --- Phase 3: take the pre-upgrade copy ---------------------------------
	// This phase asserts nothing about what is IN the archive: archive()
	// returning nil is the whole check, so do not read a green phase 3 as a
	// verified backup. Phase 8 is what verifies the contents — it restores
	// this directory and compares the result against the capture above, so a
	// file the archive silently missed fails there, by name.
	//
	// A failure here carries the phase but no log tail: phase 2 drained the
	// server, and annotate has no log to attach once t.running is nil. The
	// same is true of phases 6 and 7 between the drain and the next boot.
	if err := t.archive(archiveDir); err != nil {
		return t.annotate(phaseArchive, err)
	}
	fmt.Println(phaseArchive + ": copied data/ and config.yaml out of the stopped install")

	// --- Phase 4: the upgrade, on the SAME install directory ----------------
	// Nothing but the binary changes: no directory is moved, no file is
	// touched, no configuration is rewritten. That is the upgrade an owner
	// performs, and everything phase 5 asserts is about what survived it.
	if err := t.start("new"); err != nil {
		return err
	}
	fmt.Println(phaseUpgrade + ": the new version booted on the untouched install directory")

	// --- Phase 5: the upgrade preserved the install -------------------------
	after, err := captureState(t.installDir(), t.baseURL(), f.token, f.attachmentID)
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

// rollBack is phases 6-8 and the final drain: the half of the rehearsal that
// makes the other half mean something. It takes the pre-upgrade capture that
// phase 1 anchored, because "the rollback worked" is defined against that
// capture and nothing else.
func rollBack(t target, f fixture, before, after state, archiveDir string) error {
	// --- Phase 6: stop the new server ---------------------------------------
	// Phase 7 replaces data/ as files, so the same precondition as phase 3
	// applies in reverse: doing that under a running server is deleting the
	// database out from underneath it. drain() asserts the healthcheck stops
	// passing; it is not re-derived here.
	if err := t.drain(); err != nil {
		return err
	}
	fmt.Println(phaseDrainNew + ": the new server drained and is no longer serving")

	// --- Phase 7: put the archive back, then run the old binary again -------
	// restore() REMOVES the live data directory before copying the archive
	// over it, and that is deliberate — a reader expecting a merge should
	// read this instead. The new version wrote files the archive has never
	// heard of (data/erasure.key, data/push_vapid.key, data/erasure/), and
	// merging would leave them behind: the result would be half alpha.4 and
	// half HEAD, which is not a state any version has ever been in. The
	// rollback an owner performs is "put the copy back", and that is what an
	// owner's copy of data/ restores to.
	//
	// Note the failure here arrives without a log tail — see phase 3.
	if err := t.restore(archiveDir); err != nil {
		return t.annotate(phaseRestore, err)
	}
	if err := t.start("old"); err != nil {
		return err
	}
	fmt.Println(phaseRestore + ": the archive is back in place and the old version booted on it")

	// --- Phase 8: the rollback landed on the pre-upgrade state --------------
	rolledBack, err := captureState(t.installDir(), t.baseURL(), f.token, f.attachmentID)
	if err != nil {
		return t.annotate(phaseRollback, err)
	}
	if err := restored(before, rolledBack); err != nil {
		return t.annotate(phaseRollback, err)
	}
	// The pre-upgrade token, carried through both version swaps, still
	// authenticates as the owner — against the OLD binary and the restored
	// database this time, which is the pair an owner is left with.
	if err := sessionSurvived(t.baseURL(), f); err != nil {
		return t.annotate(phaseRollback, err)
	}
	fmt.Printf("%s: %s -> %s, everything the pre-upgrade capture recorded is back, the pre-upgrade session still works\n",
		phaseRollback, after.version, rolledBack.version)

	// The last server is drained rather than left to t.cleanup(), which kills
	// it: the old binary has to survive being run on the restored install and
	// still stop cleanly, and a kill would assert neither.
	if err := t.drain(); err != nil {
		return err
	}
	return nil
}

// restored is the phase-8 mirror of upgraded: the same two captures, the
// opposite version expectation. It is a second function rather than a
// direction flag on upgraded() because the version is the one assertion that
// differs, and a boolean at the call site would read as "check the version,
// maybe". Neither is side-effect free — compare() prints its additions line.
//
// What it covers that is easy to hunt for elsewhere: the pre-upgrade
// attachment downloading byte-identical is compare()'s download branch. The
// capture re-fetched it through the rolled-back server, so a rollback that
// restored the file but could no longer serve it fails here too.
func restored(before, rolledBack state) error {
	problems := make([]error, 0, 2)

	// The one assertion that catches a rollback which did not happen. Every
	// other check in this phase passes with the NEW binary still serving: the
	// data directory really is the pre-upgrade one, so config.yaml, the key
	// files, the uploads, the backups, the download and the session all match
	// whichever binary is reading them. Only the reported version tells
	// "the old version is serving the restored install" from "the restore
	// happened and the new binary never went away".
	if before.version != rolledBack.version {
		problems = append(problems, fmt.Errorf(
			"the reported version is %s after the rollback, want the pre-upgrade %s: the old binary is not what is serving",
			rolledBack.version, before.version))
	}
	// Subset, not equality (see compare): everything before recorded must be
	// back, byte for byte. Anything the HEAD run added and the restore removed
	// is simply absent from this side of the comparison, and that is a correct
	// rollback rather than a loss.
	if err := compare(before, rolledBack); err != nil {
		problems = append(problems, err)
	}
	return errors.Join(problems...)
}

// upgraded asserts every phase-5 promise that is answerable from the two
// captures alone.
func upgraded(f fixture, before, after state) error {
	problems := make([]error, 0, 3)

	// The one assertion that catches an upgrade which did not happen. If the
	// swap silently kept running the old binary — a stale process still
	// holding 8443, a copy that failed, the wrong path — every other
	// assertion in this file passes, because nothing about the install
	// changed. Only the reported version distinguishes "the new version
	// preserved the install" from "the old version is still serving it".
	if before.version == after.version {
		problems = append(problems, fmt.Errorf(
			"the reported version is still %s after the upgrade: the new binary is not what is serving",
			after.version))
	}
	if err := compare(before, after); err != nil {
		problems = append(problems, err)
	}
	// The database was not recreated. sessionSurvived carries most of this
	// weight — a recreated database has no session row and no owner row, so
	// authenticating as the fixture owner is what proves both survived, and
	// this assertion is stated as relying on it rather than leaving it
	// implied. What it adds on its own is the pre-upgrade backup: it is a
	// file the upgrade could sweep while leaving a perfectly working
	// database, and the rollback recipe is worthless without it.
	if !slices.Contains(after.backups, f.backupName) {
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade backup %s is not listed after the upgrade, only %v", f.backupName, after.backups))
	}
	return errors.Join(problems...)
}

// sessionSurvived is the credential assertion with teeth: not "a login works
// after the upgrade" but "the session that was open BEFORE the upgrade is
// still authenticated, as the same owner". A rehearsal that logged in again
// would pass against a database the upgrade had recreated from scratch.
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
