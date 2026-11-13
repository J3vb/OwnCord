package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type rState struct {
	token       string
	victimToken string
	victimID    int64
	newcomer    string // the third account, created after the backup
	text        channelRow
	victimFile  string // V's attachment id, and the file name under uploads/
	invite      string // the invite step 3 uses, so the newcomer is created after the backup
	backup      string
	sockets     []*wsConn
	markers     markerState
}

// phaseR is drills 1 and 2 against one live install: a real backup, a real erase, a real restore through the
// admin endpoint's own self-restart, and the two ways an operator can lose the erasure history across it. A
// step's assertions accumulate rather than stop the phase, so later measurements can diagnose a failure; only
// a broken fixture stops it early.
func (d *drill) phaseR() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	if err := d.boot("R.log",
		fmt.Sprintf("OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=%d", drillAuthRateScale)); err != nil {
		return err
	}
	fmt.Printf("%s: booted with the register cap scaled by %d — %d distinct accounts are opened as %d sessions, and the per-IP cap is %d registrations a minute without it\n",
		d.phase, drillAuthRateScale, restartSockets, restartSockets, registerRateLimitPerMinute)
	r := &rState{}
	var problems []failure
	for _, step := range []func(*rState) ([]failure, error){
		d.stepRFix, d.stepRBackup, d.stepRErase, d.stepRRestore, d.stepRInspect,
	} {
		found, err := step(r)
		problems = append(problems, found...)
		if err != nil {
			return err
		}
	}
	found, err := d.stepRNoMarkerFile(r)
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	found, err = d.stepRNoErasureKey(r)
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	// The phase must leave the port free or the next phase measures its leftovers. Step 7's boot fails closed
	// and exits, which makes that true; checking turns a mystery port conflict three phases later into a failure
	// at the causing step.
	if serving(d.baseURL()) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"phase R ended with something still serving %s — the last step's boot should have failed closed and exited", d.baseURL())})
	}
	return d.failures(problems)
}

func (d *drill) stepRFix(r *rState) ([]failure, error) {
	token, err := d.setup()
	if err != nil {
		return nil, d.annotate(err)
	}
	r.token = token
	if r.text, err = pickChannel(token, "text"); err != nil {
		return nil, d.annotate(err)
	}
	invite, err := createInvite(d.baseURL(), token)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.invite = invite
	victimToken, victimID, err := registerUser(d.baseURL(), invite, drillVictim)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.victimToken, r.victimID = victimToken, victimID

	victim, err := dialWS(victimToken)
	if err != nil {
		return nil, d.annotate(err)
	}
	defer victim.close()
	for i := range victimMessages {
		frame, err := victim.chatSend(r.text.ID, fmt.Sprintf("victim message %d", i))
		if err != nil {
			return nil, d.annotate(fmt.Errorf("victim sending message %d: %w", i, err))
		}
		if err := wantOK(frame, "chat_send_ok"); err != nil {
			return nil, d.annotate(fmt.Errorf("victim sending message %d: %w", i, err))
		}
	}
	if r.victimFile, err = uploadAttachment(d.baseURL(), victimToken); err != nil {
		return nil, d.annotate(err)
	}

	// 20 sessions that stay authenticated across the restore, answering whether every connected client learns
	// the server is going away. One account each: the hub subscribes a client under its user id (ws/pubsub.go
	// Subscribe), so a second socket for one account replaces the first in the global topic and the older socket
	// gets no global broadcast (with all 20 on the owner's account only 1 received server_restart). Each account
	// costs a registration, capped at 3 a minute per IP (api/constants.go, scaled by
	// security.auth_rate_limit_multiplier), so the boot scales that cap; otherwise the third registration is
	// refused with 429.
	// Invite creation is capped per user per hour, so the sessions share invites up to each one's max_uses
	// instead of spending one invite per account.
	var sessionInvite string
	for i := range restartSockets {
		if i%inviteMaxUses == 0 {
			if sessionInvite, err = createInvite(d.baseURL(), token); err != nil {
				return nil, d.annotate(fmt.Errorf("inviting session %d of %d: %w", i+1, restartSockets, err))
			}
		}
		clientToken, _, err := registerUser(d.baseURL(), sessionInvite, fmt.Sprintf("drill-client-%d", i+1))
		if err != nil {
			return nil, d.annotate(fmt.Errorf("registering session %d of %d: %w", i+1, restartSockets, err))
		}
		c, err := dialWS(clientToken)
		if err != nil {
			return nil, d.annotate(fmt.Errorf("opening session %d of %d: %w", i+1, restartSockets, err))
		}
		r.sockets = append(r.sockets, c)
	}
	fmt.Printf("%s: fixture ready — %d messages and one upload from %s, %d sessions open (one account each)\n",
		d.phase, victimMessages, drillVictim, len(r.sockets))
	return nil, nil
}

// stepRBackup takes the backup a restore is made from and integrity-checks it out of process: a backup that
// fails the check is worse than none, because the operator believes they have one.
func (d *drill) stepRBackup(r *rState) ([]failure, error) {
	name, err := createBackup(d.baseURL(), r.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.backup = name
	path := filepath.Join(d.backupDir(), name)
	answer, err := integrityCheck(path)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: backup %s integrity_checks to %q\n", d.phase, name, answer)
	if answer != "ok" {
		return []failure{{what: fmt.Sprintf("the backup the drill just took (%s) does not integrity_check: %s", name, answer)}}, nil
	}
	return nil, nil
}

// stepRErase erases V through the account erasure route and asserts the marker file recorded it: a marker
// never written is a restore that resurrects an erased account, and nothing else would notice.
func (d *drill) stepRErase(r *rState) ([]failure, error) {
	if err := wantStatus(http.MethodDelete,
		fmt.Sprintf("/admin/api/users/%d", r.victimID), r.token, http.StatusNoContent); err != nil {
		return nil, d.annotate(err)
	}
	state, err := readMarkers(d.dataDir())
	if err != nil {
		return nil, d.annotate(err)
	}
	r.markers = state
	fmt.Printf("%s: erased %s (user %d); the marker file holds %d marker(s), token %s\n",
		d.phase, drillVictim, r.victimID, state.count, shortToken(state.token))
	if state.count != 1 || state.token == "" {
		return []failure{{what: fmt.Sprintf(
			"erasing a user recorded %d marker(s) with token %q, want exactly one with a token",
			state.count, state.token)}}, nil
	}

	// The newcomer is registered after the backup on purpose: a restore that rolled the install back must drop
	// it; created before, "the restore drops newer data" could only pass.
	if r.newcomer, _, err = registerUser(d.baseURL(), r.invite, drillNewcomer); err != nil {
		return nil, d.annotate(err)
	}

	// The live erase removed V's file and a backup holds the database, not the uploads, so without writing it
	// back "V's file is gone" would hold vacuously. Writing it back is what an operator restoring a file set
	// does, leaving the startup replay as the only thing that can satisfy the check.
	if err := os.WriteFile(filepath.Join(d.uploadsDir(), r.victimFile), fixturePayload(), 0o600); err != nil {
		return nil, d.annotate(fmt.Errorf("restoring V's upload file by hand, to give the replay something to remove: %w", err))
	}
	fmt.Printf("%s: wrote V's upload file back (the operator's file set) so the replay has something to remove\n", d.phase)
	return nil, nil
}

func (d *drill) stepRRestore(r *rState) ([]failure, error) {
	// The reader is issued just before the restore POST and collected after, so the request overlaps the
	// restore. Its outcome is a measurement, not an assertion: the restore closes the database under any
	// in-flight read by design.
	reader := readWhileRestoring(r.token, r.text.ID)

	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: the restore answered 200; the reader in flight says %s\n", d.phase, <-reader)

	var problems []failure
	silent := 0
	for i, c := range r.sockets {
		if _, err := c.await(restartBroadcastBudget, "server_restart"); err != nil {
			silent++
			if silent == 1 {
				problems = append(problems, failure{what: fmt.Sprintf(
					"session %d of %d never received server_restart before the connection closed: %v",
					i+1, len(r.sockets), err)})
			}
		}
	}
	if silent > 1 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d of the %d open sessions never received server_restart (the first is reported above)",
			silent, len(r.sockets))})
	}
	if err := d.awaitRestart(); err != nil {
		return problems, err
	}
	return problems, nil
}

// stepRInspect reads the install the restore produced; each assertion is one an owner would make after
// restoring, in order, and its own function: the sequence is the spec.
func (d *drill) stepRInspect(r *rState) ([]failure, error) {
	var problems []failure
	fail := func(format string, args ...any) {
		problems = append(problems, failure{what: fmt.Sprintf(format, args...)})
	}
	for _, inspect := range []func() error{
		func() error { return d.inspectSafetyCopies(fail) },
		func() error { return d.inspectLiveDatabase(fail) },
		func() error { return d.inspectErasureHeld(r, fail) },
		func() error { return d.inspectPostBackupDataGone(r, fail) },
		func() error { return d.inspectAuditTrail(r, fail) },
		func() error { return d.inspectUploadGone(r, fail) },
		func() error { return d.inspectMarkerSurvived(r, fail) },
	} {
		if err := inspect(); err != nil {
			return nil, d.annotate(err)
		}
	}
	return problems, nil
}

// stepRNoMarkerFile is drill 2's first half: the marker file is gone and the same backup is restored again.
// The server must boot and log a startup error that its erasure history is absent, not refuse to boot; what
// it measures either way is printed, since the erased account coming back is what the operator must know. The
// delete is attempted while the replacement runs and the restore takes the process down: the replacement is
// not this harness's child (see awaitRestart), and this is the one order in which the marker file is absent
// when the next process opens it. The -wal and -shm sidecars go with it; a fresh empty file beside a live
// -wal is not the state of an operator who deleted the marker file.
func (d *drill) stepRNoMarkerFile(r *rState) ([]failure, error) {
	markers := filepath.Join(d.dataDir(), filepath.FromSlash(markerRelPath))
	deleted := 0
	for _, path := range []string{markers, markers + "-wal", markers + "-shm"} {
		err := os.Remove(path)
		switch {
		case err == nil:
			deleted++
		case errors.Is(err, fs.ErrNotExist):
		default:
			// Windows refuses to unlink a file another process holds open, and the running server holds this one for
			// its whole life: a limit of this machine, not a measurement, so recorded as not run, never a pass.
			d.skipStep(fmt.Sprintf("step 6 did not run (%v — the running server holds the marker file open; only a stopped server can lose it on this platform)", err))
			return nil, nil
		}
	}
	if deleted == 0 {
		d.skipStep("step 6 did not run (there was no marker file to delete)")
		return nil, nil
	}
	if deleted < 3 {
		// The marker file went but a sidecar did not. The install is already mutated, so neither a skip nor a clean
		// run: say which files survived and carry on.
		d.skipStep(fmt.Sprintf("step 6 ran on a partially deleted marker set (%d of 3 files removed; SQLite's sidecars are still present)", deleted))
	}
	offset, err := logOffset(d.srv.logPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	outcome, err := d.awaitUnwatchedRestart(offset)
	if err != nil {
		return nil, err
	}
	// Whatever comes next owns the port; the log and directory are the same.
	d.srv = &server{bin: d.bin, dir: d.dir, logPath: d.srv.logPath, adopted: true, waitErr: make(chan error, 1)}

	var problems []failure
	alive := false
	if outcome.booted {
		var who string
		var err error
		if alive, who, err = authenticated(r.victimToken); err != nil {
			return nil, d.annotate(err)
		}
		fmt.Printf("%s: with the marker file deleted the install booted and the erased account is %s\n",
			d.phase, erasedPhrase(alive))
		if alive {
			// Recorded, not failed: a missing marker file boots by design, and the markers are what names an erased
			// account in a restored backup, so with them gone nothing can remove it. Still the loudest thing step 6
			// measures.
			fmt.Printf("%s: RESURRECTION — %s authenticated again after the restore and nothing removes it (the markers that named it are gone). Decided behaviour, measured here rather than asserted.\n",
				d.phase, who)
		}
	}
	// Expected as a whole: it boots and says its erasure history is gone. Refusing to boot is safer but not
	// intended; booting silently is the failure this guards against.
	switch {
	case !outcome.booted:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the marker file was deleted and the server refused to boot; the decided behaviour (open question 1) is that it boots and logs a startup error that the erasure history is absent. The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	case !saysHistoryGone(outcome.tail):
		problems = append(problems, failure{what: fmt.Sprintf(
			"the marker file was deleted and the boot said nothing about the erasure history it no longer has. Decided behaviour (open question 1): boot, and log a startup error that the erasure history is absent — an operator who deleted the marker file by mistake is otherwise told nothing, and the erased account %s",
			erasedPhrase(alive))})
	}
	return problems, nil
}

// stepRNoErasureKey is drill 2's second half: the key is gone and the marker file intact. The marker file is
// bound to the key by fingerprint, so the boot must fail closed with a named reason rather than serve with
// markers it cannot match.
func (d *drill) stepRNoErasureKey(r *rState) ([]failure, error) {
	if err := os.Remove(filepath.Join(d.dataDir(), erasureKeyRelPath)); err != nil {
		return nil, d.annotate(fmt.Errorf("deleting %s: %w", erasureKeyRelPath, err))
	}
	offset, err := logOffset(d.srv.logPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	outcome, err := d.awaitUnwatchedRestart(offset)
	if err != nil {
		return nil, err
	}
	var problems []failure
	switch {
	case outcome.booted:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the erasure key was deleted and the server booted anyway on a marker file created under a different key: its markers name subjects the running key cannot match, so a restored backup leaves erased accounts serving (OC-0388). The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	case !strings.Contains(outcome.tail, "different erasure key"):
		problems = append(problems, failure{what: fmt.Sprintf(
			"the erasure key was deleted and the boot failed, but without naming the reason — a refusal an operator cannot act on is indistinguishable from a crash. The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	default:
		fmt.Printf("%s: with the erasure key deleted the boot failed closed and named the reason\n", d.phase)
	}
	return problems, nil
}
