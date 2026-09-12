package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
)

// Phase names, kept together because they are what a CI failure is grepped by
// and what the log tail is labelled with.
const (
	phasePopulate = "phase 1 (populate)"
	phaseDrainOld = "phase 2 (drain old)"
	phaseArchive  = "phase 3 (archive)"
	phaseUpgrade  = "phase 4 (upgrade)"
	phaseVerify   = "phase 5 (verify)"
)

// runUpgrade rehearses an upgrade from oldRef to newRef and the rollback back
// out of it, against whichever deployment mode the flags selected.
//
// The order of phases 2 and 3 is not arbitrary and must not be tidied: the
// archive copies data/chatserver.db as a file, and docs/deployment.md says in
// as many words never to copy the database out from under a running server —
// a hot copy of SQLite and its WAL is not a consistent snapshot. An owner
// stops the server before taking the pre-upgrade copy, so the rehearsal does
// too, and standaloneTarget.archive's own precondition says the same.
//
// The rollback half is B6-8 Task 4.
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

	return errors.New("the rollback phases are not implemented yet (B6-8 Task 4): " +
		"the upgrade half passed, but a rehearsal that cannot roll back has not rehearsed the thing it is for")
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
