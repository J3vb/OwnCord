package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// archiveFromDownload takes the archive through the owner's download route at once. It is the default and
	// what the nightly runs.
	archiveFromDownload = "download"
	// archiveFromSchedule waits for the archive the server's own maintenance loop stores (its tick is fixed at
	// 15 minutes), for a local run that wants the schedule's wiring too.
	archiveFromSchedule = "scheduled"

	// scheduledArchiveBudget is how long, counted from the boot, the schedule gets to store an archive: the
	// maintenance tick is fixed at 15 minutes, so this is one tick and some slack for the build.
	scheduledArchiveBudget = 18 * time.Minute
	archivePollEvery       = 10 * time.Second

	drillTOTPUser   = "drill-2fa"
	drillErasedUser = "drill-erased"

	seededPerUser  = 5
	erasedMessages = 3
)

// bUser is one account phase B made.
type bUser struct {
	name  string
	id    int64
	token string
}

// bState is what phase B carries from the source install to the restored one.
type bState struct {
	root, source string
	bootedAt     time.Time

	ownerToken string
	channel    channelRow
	twoFA      bUser
	erased     bUser
	secret     string
	lastStep   int64 // the highest TOTP step a code was used for before the archive
	seeded     []seededMessage
	fileID     string
	markers    markerState
	keyHashes  map[string]string
	archive    string // the zip, outside the install it came from
}

type problemList []failure

func (p *problemList) addf(format string, args ...any) {
	*p = append(*p, failure{what: fmt.Sprintf(format, args...)})
}

// phaseB is the owner's worst day: the server and its folder are gone and only the full archive is left. It
// seeds an install, takes the full archive through the owner's download route (or, in a local run that asks for it, waits for the one the schedule stores), deletes the install, unpacks the archive
// into a fresh folder, boots it and asks the public API whether the install came back. It then restores the
// same archive without data/totp.key and requires the same TOTP check to fail, which shows the check can fail.
func (d *drill) phaseB() error {
	if set := inheritedKeyEnv(os.LookupEnv); len(set) > 0 {
		return fmt.Errorf("%s is set in this environment: the restored server would take its key from there and not from the archive, and the restore would prove nothing", strings.Join(set, ", "))
	}
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	b := &bState{root: d.dir, source: filepath.Join(d.dir, "source")}
	var problems problemList
	for _, step := range []func(*bState) error{
		d.stepBSource, d.stepBSeed, d.stepBArchive, d.stepBDisaster, d.stepBRestore,
	} {
		if err := step(b); err != nil {
			return err
		}
	}
	for _, step := range []func(*bState, *problemList) error{d.stepBVerify, d.stepBNegative} {
		if err := step(b, &problems); err != nil {
			return err
		}
	}
	if serving(d.baseURL()) {
		problems.addf("phase B ended with something still serving %s, want the port free for the next phase", d.baseURL())
	}
	return d.failures(problems)
}

// stepBSource boots the install the archive is taken from and makes the owner.
func (d *drill) stepBSource(b *bState) error {
	b.bootedAt = time.Now()
	if err := d.bootAt(b.source, "B-source.log", fmt.Sprintf("OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=%d", drillAuthRateScale)); err != nil {
		return err
	}
	token, err := d.setup()
	if err != nil {
		return d.annotate(err)
	}
	b.ownerToken = token
	if b.channel, err = pickChannel(token, "text"); err != nil {
		return d.annotate(err)
	}
	return d.requireArchiveDefaults(token)
}

// requireArchiveDefaults fails unless a fresh install is set to produce the archive on its own.
func (d *drill) requireArchiveDefaults(token string) error {
	var settings map[string]string
	if err := get("/admin/api/settings", token, &settings); err != nil {
		return d.annotate(err)
	}
	if schedule, scope := settings["backup_schedule"], settings["backup_scope"]; schedule != "daily" || scope != "everything" {
		return d.annotate(fmt.Errorf("a fresh install has backup_schedule %q and backup_scope %q, want daily and everything: the schedule would store no full archive", schedule, scope))
	}
	return nil
}

// stepBSeed fills the install: a second-factor account, an account that is then erased, messages, an upload.
func (d *drill) stepBSeed(b *bState) error {
	invite, err := createInvite(d.baseURL(), b.ownerToken)
	if err != nil {
		return d.annotate(err)
	}
	for _, u := range []*bUser{{name: drillTOTPUser}, {name: drillErasedUser}} {
		if u.token, u.id, err = registerUser(d.baseURL(), invite, u.name); err != nil {
			return d.annotate(err)
		}
		if u.name == drillTOTPUser {
			b.twoFA = *u
		} else {
			b.erased = *u
		}
	}
	if err := d.seedTOTP(b); err != nil {
		return d.annotate(err)
	}
	if err := d.seedMessages(b); err != nil {
		return d.annotate(err)
	}
	if b.fileID, err = uploadAttachment(d.baseURL(), b.twoFA.token); err != nil {
		return d.annotate(err)
	}
	return d.seedErasure(b)
}

// seedTOTP enrols the account and signs in once on the source, so the restore has a used code to be refused
// against and a known-good sign-in to compare with.
func (d *drill) seedTOTP(b *bState) error {
	secret, err := enrolTOTP(b.twoFA.token)
	if err != nil {
		return err
	}
	b.secret = secret
	if b.lastStep, err = confirmTOTP(b.twoFA.token, secret); err != nil {
		return err
	}
	res, err := checkTOTPSignIn(b.twoFA.name, secret, b.lastStep)
	if err != nil {
		return err
	}
	if res.status != http.StatusOK || res.token == "" {
		return fmt.Errorf("the second-factor sign-in on the source install was refused with %d: %s", res.status, res.detail)
	}
	b.lastStep = res.step
	// Enrolment ends the account's other sessions but not the one that confirmed it; if it did, say so here and
	// not as a puzzling failure later.
	if ok, _, err := authenticated(b.twoFA.token); err != nil || !ok {
		return fmt.Errorf("the session that confirmed the enrolment stopped working (err %v)", err)
	}
	return nil
}

func (d *drill) seedMessages(b *bState) error {
	ownerUID, err := ownerID(b.ownerToken)
	if err != nil {
		return d.annotate(err)
	}
	senders := []struct {
		token, label string
		userID       int64
		n            int
		kept         bool
	}{
		{b.erased.token, drillErasedUser, b.erased.id, erasedMessages, false},
		{b.ownerToken, "owner", ownerUID, seededPerUser, true},
		{b.twoFA.token, drillTOTPUser, b.twoFA.id, seededPerUser, true},
	}
	for _, s := range senders {
		sent, err := sendSeeded(s.token, s.userID, b.channel.ID, s.label, s.n)
		if err != nil {
			return d.annotate(err)
		}
		if s.kept {
			b.seeded = append(b.seeded, sent...)
		}
	}
	return nil
}

// seedErasure erases the account through the owner's route and checks the marker file recorded it.
func (d *drill) seedErasure(b *bState) error {
	if err := wantStatus(http.MethodDelete, fmt.Sprintf("/admin/api/users/%d", b.erased.id), b.ownerToken, http.StatusNoContent); err != nil {
		return d.annotate(err)
	}
	state, err := readMarkers(filepath.Join(b.source, "data"))
	if err != nil {
		return d.annotate(err)
	}
	if state.count != 1 || state.token == "" {
		return d.annotate(fmt.Errorf("erasing a user recorded %d marker(s) with token %q, want exactly one with a token", state.count, state.token))
	}
	b.markers = state
	rows, err := channelHistory(b.ownerToken, b.channel.ID)
	if err != nil {
		return d.annotate(err)
	}
	for _, row := range rows {
		if row.userID == b.erased.id {
			return d.annotate(fmt.Errorf("the erased account's message %d is still in the history before the archive, so the check that it stays gone would hold over nothing", row.id))
		}
	}
	fmt.Printf("%s: source seeded — owner and %s with %d messages each, an upload, a TOTP enrolment, %s erased (marker %s)\n",
		d.phase, drillTOTPUser, seededPerUser, drillErasedUser, shortToken(state.token))
	return nil
}

// stepBArchive gets the zip the disaster starts from.
func (d *drill) stepBArchive(b *bState) error {
	b.archive = filepath.Join(b.root, "archive.zip")
	if d.archiveSource != archiveFromSchedule {
		if err := downloadArchive(b.ownerToken, b.archive); err != nil {
			return d.annotate(err)
		}
		return nil
	}
	name, err := d.awaitScheduledArchive(b)
	if err != nil {
		return err
	}
	// The owner's "take it from the backup folder" path.
	if err := copyFile(filepath.Join(b.source, "data", "backups", name), b.archive, 0o600); err != nil {
		return d.annotate(fmt.Errorf("taking %s from the backup folder: %w", name, err))
	}
	fmt.Printf("%s: the schedule stored %s %s after the boot\n", d.phase, name, time.Since(b.bootedAt).Round(time.Second))
	return nil
}

// awaitScheduledArchive polls the backup list for a full archive, for at most scheduledArchiveBudget from the
// boot, and on a miss names the scheduler's own failure line when the log has one.
func (d *drill) awaitScheduledArchive(b *bState) (string, error) {
	deadline := b.bootedAt.Add(scheduledArchiveBudget)
	next := time.Now()
	fmt.Printf("%s: waiting for the schedule's full archive (the maintenance tick is every 15 minutes)\n", d.phase)
	for {
		entries, err := listBackupEntries(b.ownerToken)
		if err != nil {
			return "", d.annotate(err)
		}
		if name, ok := firstFullArchive(entries); ok {
			return name, nil
		}
		if time.Now().After(deadline) {
			return "", d.annotate(fmt.Errorf("no full archive was stored within %s of the boot%s", scheduledArchiveBudget, d.scheduledFailureLine()))
		}
		if time.Now().After(next) {
			fmt.Printf("%s: no full archive yet, %s after the boot\n", d.phase, time.Since(b.bootedAt).Round(time.Second))
			next = time.Now().Add(2 * time.Minute)
		}
		time.Sleep(archivePollEvery)
	}
}

func (d *drill) scheduledFailureLine() string {
	text, err := d.logText()
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(text, "\n") {
		if strings.Contains(line, "scheduled archive failed") {
			return " — the server logged: " + strings.TrimSpace(line)
		}
	}
	return ""
}

// stepBDisaster notes the keys, stops the server and deletes its whole install, so nothing it left behind can
// help the restore.
func (d *drill) stepBDisaster(b *bState) error {
	b.keyHashes = map[string]string{}
	for _, rel := range []string{"data/totp.key", "data/erasure.key"} {
		sum, err := hashFile(filepath.Join(b.source, filepath.FromSlash(rel)))
		if err != nil {
			return d.annotate(fmt.Errorf("reading %s before the disaster: %w", rel, err))
		}
		b.keyHashes[rel] = sum
	}
	if err := d.stop(); err != nil {
		return err
	}
	if err := os.RemoveAll(b.source); err != nil {
		return fmt.Errorf("deleting the source install: %w", err)
	}
	return nil
}

// stepBRestore unpacks the archive into a fresh folder, checks what the owner's guide says to check, and
// boots it.
func (d *drill) stepBRestore(b *bState) error {
	dir := filepath.Join(b.root, "restored")
	if err := unpackArchive(b.archive, dir, nil); err != nil {
		return fmt.Errorf("restoring into %s: %w", filepath.Base(dir), err)
	}
	for rel, want := range b.keyHashes {
		got, err := hashFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return fmt.Errorf("reading the restored %s: %w", rel, err)
		}
		if got != want {
			return fmt.Errorf("the restored %s is not the one the source had", rel)
		}
	}
	hits, err := configFilesNaming(dir, b.source)
	if err != nil {
		return err
	}
	if len(hits) > 0 {
		return fmt.Errorf("the restored %s names the deleted install %s, so the restore would reach back into it", strings.Join(hits, " and "), b.source)
	}
	return d.bootAt(dir, "B-restored.log", fmt.Sprintf("OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=%d", drillAuthRateScale))
}
