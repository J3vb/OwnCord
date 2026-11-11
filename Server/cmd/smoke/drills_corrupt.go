package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// phaseC is drill 5's process half: the two corrupt inputs an operator can hand a running server, a damaged
// backup to restore and a config.yaml with a syntax error. "The live server refused and stayed up" is not a
// property of a copy, which is all the db tests exercise.
func (d *drill) phaseC() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	if err := d.boot("C.log"); err != nil {
		return err
	}
	var problems []failure
	found, err := d.stepCCorruptBackup()
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	found, err = d.stepCBrokenConfig()
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	if err := d.failures(problems); err != nil {
		return err
	}
	return d.stop()
}

// stepCCorruptBackup hands the restore a backup with bytes overwritten. It must be refused: otherwise a live
// database is overwritten with a file SQLite rejects, with only the pre-restore safety copy between the
// operator and a dead install.
func (d *drill) stepCCorruptBackup() ([]failure, error) {
	token, err := d.setup()
	if err != nil {
		return nil, d.annotate(err)
	}
	name, err := createBackup(d.baseURL(), token)
	if err != nil {
		return nil, d.annotate(err)
	}
	path := filepath.Join(d.backupDir(), name)
	offset, err := corruptDetectably(path)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: corrupted %s at offset %d (integrity_check no longer says ok)\n", d.phase, name, offset)

	dbPath := filepath.Join(d.dataDir(), "chatserver.db")
	before, err := hashFile(dbPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	// wantStatus is the assertion: a 200 means the restore went ahead on a file SQLite rejects, and the run
	// should stop.
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+name+"/restore",
		token, http.StatusBadRequest); err != nil {
		return nil, d.annotate(fmt.Errorf("restoring a corrupt backup: %w", err))
	}
	after, err := hashFile(dbPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	if before != after {
		problems = append(problems, failure{what: fmt.Sprintf(
			"a refused restore still rewrote the live database (%s -> %s): the refusal has to happen before anything touches it",
			before[:12], after[:12])})
	}
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return nil, d.annotate(err)
	}
	if len(copies) > 0 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"a refused restore left the pre-restore safety copy %v behind: the refusal happened after the copy, not before it", copies)})
	}
	rows, err := auditLog(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	if hasAuditRow(rows, "backup_restore", "") {
		problems = append(problems, failure{what: "a refused restore wrote a backup_restore audit entry: the log now claims a restore that never happened"})
	}
	if !healthy(d.bin, d.dir) {
		problems = append(problems, failure{what: "the server stopped reporting healthy after refusing a corrupt backup"})
	}
	fmt.Printf("%s: the corrupt backup was refused with 400 and the live database is unchanged\n", d.phase)
	return problems, nil
}

// stepCBrokenConfig boots the binary on a config.yaml that does not parse. The operator needs the file and
// line in seconds; a server that boots half-configured on a typo is worse than one that refuses.
func (d *drill) stepCBrokenConfig() ([]failure, error) {
	dir := filepath.Join(d.dir, "broken-config")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// A tab where YAML wants a space: a hand-edited file's typical typo.
	const broken = "server:\n  name: drill\n\tport: 8443\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(broken), 0o600); err != nil {
		return nil, err
	}
	s, err := start(d.bin, dir, "C-broken.log", noLiveKitDownload, spawnRestart)
	if err != nil {
		return nil, err
	}
	select {
	case exit := <-s.waitErr:
		s.exited = true
		if exit == nil {
			return []failure{{what: "the binary exited 0 on a config.yaml with a syntax error: a config error that looks like a clean shutdown tells the operator nothing"}}, nil
		}
	case <-time.After(configFailBudget):
		_ = s.cmd.Process.Kill()
		return []failure{{what: fmt.Sprintf(
			"the binary was still running %s after being started on a config.yaml with a syntax error, want a non-zero exit naming the file and the line", configFailBudget)}}, nil
	}
	log, err := os.ReadFile(s.logPath)
	if err != nil {
		return nil, err
	}
	text := string(log)
	var problems []failure
	if !strings.Contains(text, "config.yaml") {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the exit message does not name the config file it refused, so the operator cannot tell which file is broken. It said:\n%s", tailExcerpt(text))})
	}
	if !configLinePattern.MatchString(text) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the exit message names no LINE, so the operator has to find the typo in a file the server already knows the position of. It said:\n%s", tailExcerpt(text))})
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !errors.Is(err, fs.ErrNotExist) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the failed boot created %s: a config that never parsed must not leave a data directory (or anything else) behind", filepath.Join(dir, "data"))})
	}
	fmt.Printf("%s: the broken config was refused in under %s, naming the file and the line\n", d.phase, configFailBudget)
	return problems, nil
}

// corruptDetectably overwrites bytes in a database file until PRAGMA integrity_check stops saying ok, and
// reports the offset. The self-check keeps the step from passing vacuously: SQLite reads only the pages a
// query touches, so a byte overwritten in a page's unallocated space is never read, and the restore's 400
// would look like a refusal of corruption it never saw.
func corruptDetectably(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	size := info.Size()
	header := make([]byte, 18)
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	_, readErr := io.ReadFull(f, header)
	_ = f.Close()
	if readErr != nil {
		return 0, fmt.Errorf("reading the header of %s: %w", filepath.Base(path), readErr)
	}
	pageSize := int64(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}

	for _, offset := range []int64{3*pageSize + 100, size / 2, size - 64, 100} {
		if offset < 100 || offset+64 > size {
			continue
		}
		if err := damageBytes(path, offset, 64); err != nil {
			return 0, err
		}
		// An error from integrity_check is detection too (a malformed image).
		if answer, err := integrityCheck(path); err != nil || answer != "ok" {
			return offset, nil //nolint:nilerr // an error from integrity_check IS the corruption this loop looks for, not a failure to detect it
		}
	}
	return 0, fmt.Errorf(
		"could not make %s detectably corrupt: 64 bytes were overwritten at four offsets and PRAGMA integrity_check still says ok, so a restore refusing this file would prove nothing",
		filepath.Base(path))
}

// damageBytes overwrites n bytes at offset with a pattern no b-tree page can be, past the page header so the
// damage is in a page's contents, not its type.
func damageBytes(path string, offset int64, n int) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(bytes.Repeat([]byte{0xFF}, n), offset); err != nil {
		_ = f.Close()
		return fmt.Errorf("corrupting %s at %d: %w", filepath.Base(path), offset, err)
	}
	return f.Close()
}
