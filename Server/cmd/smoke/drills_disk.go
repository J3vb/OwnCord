package main

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// diskEnv points every writable path phase D measures at the size-limited filesystem. server.data_dir alone
// is not enough: database.path, backup.dir and upload.storage_dir are separate keys with install-relative
// defaults, so moving only data_dir would fill a filesystem the database is not on and never reach ENOSPC.
// The TLS pair is deliberately not here: it is written once at boot so the fill cannot push it to the wall,
// and moving it would move it out from under the healthcheck, a second process reading the same config.yaml
// without this environment (see bootAt).
func (d *drill) diskEnv() []string {
	fs := d.dataFS
	return []string{
		"OWNCORD_SERVER_DATA_DIR=" + fs,
		"OWNCORD_DATABASE_PATH=" + filepath.Join(fs, "chatserver.db"),
		"OWNCORD_BACKUP_DIR=" + filepath.Join(fs, "backups"),
		"OWNCORD_UPLOAD_STORAGE_DIR=" + filepath.Join(fs, "uploads"),
		fmt.Sprintf("OWNCORD_SERVER_MIN_FREE_DISK_MB=%d", drillMinFreeDiskMB),
	}
}

// dStage is phase D's running state: the socket its messages go through, the channel and owner, and the
// acknowledgement count the database must hold after recovery (an acknowledgement and a row are the same
// promise).
type dStage struct {
	token string
	owner int64
	text  channelRow
	conn  *wsConn
	oks   int
}

// dirFiller is phase D's non-container filesystem: the directory -data-fs names. A nil filler means this
// machine has none; the skip is recorded and printed, never scored as a pass.
func (d *drill) dirFiller() (filler, error) {
	// No -data-fs, or Windows (no tmpfs, and the cap would be 64 MiB written to somebody's real volume).
	if d.dataFS == "" || runtime.GOOS == "windows" {
		// So the exit status and later phases do not read as "phase D measured nothing and was fine".
		d.skipped = append(d.skipped, 'D')
		fmt.Printf("%s: skipped (no size-limited filesystem)\n", d.phase)
		return nil, nil
	}
	if err := d.boot("D.log", d.diskEnv()...); err != nil {
		return nil, err
	}
	return newDirFiller(d.dataFS)
}

// phaseD is drills 3 and 4: the filesystem under the reserved headroom, then full to the wall, then given
// back. Standalone it runs against -data-fs; with -docker, against the tmpfs at /app/data.
func (d *drill) phaseD() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	var (
		f   filler
		err error
	)
	if !d.docker {
		if f, err = d.dirFiller(); err != nil || f == nil {
			return err
		}
	}
	if d.docker {
		t, err := newDockerTarget(d.bin, d.bin)
		if err != nil {
			return err
		}
		defer t.cleanup()
		t.tmpfs = true
		t.extraEnv = []string{fmt.Sprintf("OWNCORD_SERVER_MIN_FREE_DISK_MB=%d", drillMinFreeDiskMB)}
		if err := t.start("old"); err != nil {
			return err
		}
		d.container = t
		if f, err = newDockerFiller(t); err != nil {
			return err
		}
		// Phase D asserts on a filesystem of known size, and docker cp is the only way to put bytes into the
		// distroless container (no shell, no dd), so first ask whether this harness can reach that filesystem.
		reachable, err := d.tmpfsReachable(f)
		if err != nil || !reachable {
			return err
		}
	}

	s := &dStage{}
	if s.token, err = d.setup(); err != nil {
		return d.annotate(err)
	}
	if s.text, err = pickChannel(s.token, "text"); err != nil {
		return d.annotate(err)
	}
	if s.owner, err = ownerID(s.token); err != nil {
		return d.annotate(err)
	}
	if s.conn, err = dialWS(s.token); err != nil {
		return d.annotate(err)
	}
	defer s.conn.close()

	var problems []failure
	for _, stage := range []func(filler, *dStage) ([]failure, error){
		d.dHeadroom, d.dFull, d.dRecover,
	} {
		found, foundErr := stage(f, s)
		problems = append(problems, found...)
		if foundErr != nil {
			return foundErr
		}
	}
	if err := d.failures(problems); err != nil {
		return err
	}
	// dRecover leaves the rebooted server running and the next phase asserts nothing serves :8443; without this
	// it would fail with a true statement blamed on the wrong phase.
	return d.stop()
}

// tmpfsReachable reports whether this harness can put bytes into the container's tmpfs at all. docker cp
// resolves its destination in the container's rootfs, below a mount at that path, so bytes copied into a
// --tmpfs mount point land in the layer underneath while the server's filesystem stays empty: the copy
// reports success and the tmpfs zero used. The probe copies more than the mount holds; if that succeeds
// nothing after it would measure disk pressure, so a stage that measured nothing must report only a skip. A
// false result has already recorded that skip.
func (d *drill) tmpfsReachable(f filler) (bool, error) {
	probe := uint64(drillTmpfsBytes + drillFillStep)
	n, err := f.fill(probe)
	switch {
	case err == nil && n == probe:
		if err := f.release(); err != nil {
			return false, d.annotate(err)
		}
		d.skipped = append(d.skipped, 'D')
		fmt.Printf("%s: skipped (docker cp put %d MiB into the container's %d MiB tmpfs and the copy succeeded — it writes below the mount, so the filesystem the server writes to never took a byte)\n",
			d.phase, probe>>20, drillTmpfsBytes>>20)
		return false, nil
	case err != nil && !errors.Is(err, errNoSpace):
		// Neither full nor success: the harness itself failed; keep the raw error to tell that from ENOSPC.
		return false, d.annotate(err)
	case errors.Is(err, errNoSpace):
		// The probe may have left a partial file: free it before setup runs.
		if err := f.release(); err != nil {
			return false, d.annotate(err)
		}
	}
	return true, nil
}

// dHeadroom fills until the product's own health report says the disk is under
// its floor, then asks drill 3's questions: health, upload, message.
func (d *drill) dHeadroom(f filler, s *dStage) ([]failure, error) {
	if err := d.fillToHealthFloor(f); err != nil {
		return nil, err
	}
	var problems []failure
	fail := func(format string, args ...any) {
		problems = append(problems, failure{what: fmt.Sprintf(format, args...)})
	}
	body, status, err := healthOf()
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: headroom reached — /health %d %s/%s\n", d.phase, status, body.Status, body.Reason)
	if status != http.StatusServiceUnavailable || body.Status != "degraded" || body.Reason != "disk" {
		fail("with the data filesystem under the %d MiB boot floor /health answered %d %s/%s, want 503 degraded/disk",
			drillMinFreeDiskMB, status, body.Status, body.Reason)
	}

	code, detail, err := uploadStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: an upload under the floor answered %d %s\n", d.phase, code, detail)
	if code != http.StatusInsufficientStorage || !strings.Contains(detail, "STORAGE_LOW_DISK") {
		fail("an upload with the filesystem under its reserved headroom answered %d %s, want 507 STORAGE_LOW_DISK", code, detail)
	}

	frame, err := s.conn.chatSend(s.text.ID, "headroom")
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantOK(frame, "chat_send_ok"); err != nil {
		fail("a message sent while the filesystem was under its floor was refused: %v — the floor is the upload path's reserved headroom, not the message path's", err)
	} else {
		s.oks++
	}

	found, err := d.dBackup(s)
	problems = append(problems, found...)
	return problems, err
}

// dBackup takes a backup with the filesystem nearly full and asserts the no-partial-file invariant, not an
// error: a small database may fit in the window above 2 MiB, so either way no partial file may remain and a
// 200 must be a file that integrity_checks. The measured status is printed.
func (d *drill) dBackup(s *dStage) ([]failure, error) {
	before, err := listBackups(d.baseURL(), s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	code, detail, err := backupStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	after, err := listBackups(d.baseURL(), s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	fresh := newNames(before, after)
	fmt.Printf("%s: a backup under the floor answered %d %s, leaving %d new file(s) %v\n",
		d.phase, code, detail, len(fresh), fresh)
	for _, name := range fresh {
		path, err := d.backupFile(name)
		if err != nil {
			return nil, d.annotate(err)
		}
		answer, err := integrityCheck(path)
		if err != nil {
			problems = append(problems, failure{what: fmt.Sprintf(
				"a backup taken under the %d MiB floor left %s behind as a file PRAGMA integrity_check cannot read (%v): an interrupted VACUUM INTO must be removed (OC-0212) rather than offered as a restorable backup",
				drillMinFreeDiskMB, name, err)})
		} else if answer != "ok" {
			problems = append(problems, failure{what: fmt.Sprintf(
				"a backup taken under the %d MiB floor left %s behind with integrity_check %q: the file is listed as a backup an operator can restore, and it is not one (OC-0212)",
				drillMinFreeDiskMB, name, answer)})
		}
	}
	if code == http.StatusOK && len(fresh) == 0 {
		problems = append(problems, failure{what: "the backup endpoint answered 200 with no new file in the backup list"})
	}
	return problems, nil
}

// dFull fills to the wall and sends 50 messages: every send must be answered, the server must still be there,
// and the log must name what happened. Quiet paths are recorded as candidate findings only this drill can
// see.
func (d *drill) dFull(f filler, s *dStage) ([]failure, error) {
	if err := d.fillToWall(f); err != nil {
		return nil, err
	}
	fmt.Printf("%s: full — %d MiB of junk on the filesystem, which now refuses more\n", d.phase, f.total()>>20)
	var problems []failure
	silent, refused, acked, throttled := 0, 0, 0, 0
	for i := range drillFullSends {
		if i > 0 {
			// Paced: the chat rate limit refuses before the disk is touched.
			time.Sleep(drillFullSendPause)
		}
		frame, err := s.conn.chatSend(s.text.ID, fmt.Sprintf("full %d", i))
		switch classifyFullSend(frame, err) {
		case fullSendAcked:
			acked++
		case fullSendRefused:
			refused++
		case fullSendThrottled:
			throttled++
		default:
			silent++
		}
	}
	s.oks += acked
	fmt.Printf("%s: %d sends on a full filesystem — %d acknowledged, %d refused with an error frame, %d unanswered, %d answered %s\n",
		d.phase, drillFullSends, acked, refused, silent, throttled, errCodeRateLimited)
	if throttled > 0 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d of %d chat_sends were answered %s: the chat rate limit refuses a send before the disk is read, so those sends measured this harness's pacing and not the full filesystem, and a verdict that counted them would assert the disk path having watched the rate limiter",
			throttled, drillFullSends, errCodeRateLimited)})
	}
	if silent > 0 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d of %d chat_sends on a full filesystem were answered with nothing at all: the server must answer every send with an error frame, and an unanswered send is a client that waits forever",
			silent, drillFullSends)})
	}
	if refused == 0 && silent == 0 {
		// The other half of the claim, which silence cannot catch: if nothing was refused the filesystem was not
		// full. Guarded on no silence too, since fifty unanswered sends is a server that stopped answering, not a
		// fill failure.
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d chat_sends on a full filesystem and not one was refused: the fixture proves nothing about the disk path, and a pass here would assert that a full disk refuses writes having never seen one refused",
			drillFullSends)})
	}

	body, status, err := healthOf()
	if err != nil {
		return nil, d.annotate(err)
	}
	if status != http.StatusServiceUnavailable || body.Reason != "disk" {
		problems = append(problems, failure{what: fmt.Sprintf(
			"with the filesystem full /health answered %d %s/%s, want 503 degraded/disk: the one endpoint that is supposed to tell an owner what is wrong must still answer when it is wrong",
			status, body.Status, body.Reason)})
	}

	text, err := d.logText()
	if err != nil {
		return nil, d.annotate(err)
	}
	if !mentionsFullDisk(text) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the log never names the disk being full: neither SQLITE_FULL nor \"database or disk is full\" appears in %d bytes of server output, so an operator reading the log after the fact has nothing to go on",
			len(text))})
	}
	quiet := quietPaths(text)
	fmt.Printf("%s: the log's disk-pressure and background-writer lines (%d):\n", d.phase, len(quiet))
	for i, line := range quiet {
		if i == 40 {
			fmt.Printf("%s: ... and %d more\n", d.phase, len(quiet)-i)
			break
		}
		fmt.Printf("  %s\n", line)
	}
	return problems, nil
}

func (d *drill) dRecover(f filler, s *dStage) ([]failure, error) {
	if err := f.release(); err != nil {
		return nil, d.annotate(err)
	}
	if err := d.awaitHealthyAgain(); err != nil {
		return nil, err
	}
	var problems []failure
	frame, err := s.conn.chatSend(s.text.ID, "recovered")
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantOK(frame, "chat_send_ok"); err != nil {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after the space was given back the server still refuses messages: %v — a server that does not recover when the disk does leaves the operator restarting it for an hour", err)})
	} else {
		s.oks++
	}
	code, detail, err := uploadStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: after the space was given back an upload answered %d %s\n", d.phase, code, detail)
	if code != http.StatusCreated {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after the space was given back an upload answered %d %s, want 201: the reserved headroom is back, so the upload path has no reason to refuse", code, detail)})
	}

	if d.docker {
		// A container's /app/data is a tmpfs destroyed with the container, so a reboot would measure a fresh
		// install, not a recovery. Record the skip: a plain print would leave the leg reporting a pass over a step
		// that never ran.
		d.skipStep("the durability half is standalone-only — /app/data is a tmpfs, destroyed with the container")
		return problems, nil
	}
	found, err := d.dRebootCount(s)
	problems = append(problems, found...)
	return problems, err
}

// dRebootCount restarts the install and checks the acknowledgement promise: every message the server said it
// stored is a row, and every row is one it said it stored. Kept-but-unacknowledged and acknowledged-and-lost
// are both findings.
func (d *drill) dRebootCount(s *dStage) ([]failure, error) {
	if err := d.stop(); err != nil {
		return nil, err
	}
	if err := d.boot("D2.log", d.diskEnv()...); err != nil {
		return nil, err
	}
	var problems []failure
	answer, err := integrityCheck(filepath.Join(d.dataFS, "chatserver.db"))
	if err != nil {
		return nil, d.annotate(err)
	}
	if answer != "ok" {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after a full filesystem was given back and the server restarted, the database does not integrity_check: %s", answer)})
	}
	rows, err := messageRows(d.dataFS, s.text.ID, s.owner)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: after the restart the database holds %d row(s) for %d acknowledged send(s)\n", d.phase, rows, s.oks)
	switch {
	case rows < s.oks:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the database holds %d message row(s) for %d send(s) the server acknowledged: %d message(s) were acknowledged and lost",
			rows, s.oks, s.oks-rows)})
	case rows > s.oks:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the database holds %d message row(s) for %d send(s) the server acknowledged: %d message(s) were stored without an acknowledgement, so the sender was told they failed",
			rows, s.oks, rows-s.oks)})
	}
	return problems, nil
}
