package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// openSQLite opens a database file with the server's own pure-Go driver, so integrity and marker checks do
// not have the server grade itself.
func openSQLite(path string) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	// One connection: reads of a file a live server may hold open; a pool would open several for nothing.
	db.SetMaxOpenConns(1)
	return db, nil
}

func integrityCheck(path string) (string, error) {
	db, err := openSQLite(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()
	var answer string
	if err := db.QueryRowContext(context.Background(), "PRAGMA integrity_check").Scan(&answer); err != nil {
		return "", fmt.Errorf("integrity_check on %s: %w", filepath.Base(path), err)
	}
	return answer, nil
}

// markerState is what the deletion-marker file says, read directly because it lives outside the database, so
// a restore cannot touch it.
type markerState struct {
	count int
	token string
}

func readMarkers(dataDir string) (markerState, error) {
	path := filepath.Join(dataDir, filepath.FromSlash(markerRelPath))
	db, err := openSQLite(path)
	if err != nil {
		return markerState{}, err
	}
	defer func() { _ = db.Close() }()
	var state markerState
	if err := db.QueryRowContext(context.Background(),
		`SELECT COUNT(*), COALESCE(MAX(subject_token), '') FROM deletion_markers WHERE state = 'recorded'`,
	).Scan(&state.count, &state.token); err != nil {
		return markerState{}, fmt.Errorf("reading the deletion markers: %w", err)
	}
	return state, nil
}

// messageRows counts the rows for phase D's acknowledgement assertion: every message the server said it
// stored is a row and every row was acknowledged.
func messageRows(dataDir string, channelID, userID int64) (int, error) {
	db, err := openSQLite(filepath.Join(dataDir, "chatserver.db"))
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	var n int
	if err := db.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM messages WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(&n); err != nil {
		return 0, fmt.Errorf("counting message rows: %w", err)
	}
	return n, nil
}

func (d *drill) inspectSafetyCopies(fail func(string, ...any)) error {
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return err
	}
	if len(copies) == 0 {
		fail("the restore left no pre_restore_*.db in %s, and the admin panel promises one before it overwrites", d.backupDir())
		return nil
	}
	for _, name := range copies {
		answer, err := integrityCheck(filepath.Join(d.backupDir(), name))
		if err != nil {
			return err
		}
		if answer != "ok" {
			fail("the pre-restore safety copy %s does not integrity_check: %s", name, answer)
		}
	}
	fmt.Printf("%s: pre-restore safety copy %v integrity_checks to ok\n", d.phase, copies)
	return nil
}

// inspectLiveDatabase checks the live database is valid: it was written by overwriting a file a closed server
// held, the one moment a restore can corrupt it.
func (d *drill) inspectLiveDatabase(fail func(string, ...any)) error {
	answer, err := integrityCheck(filepath.Join(d.dataDir(), "chatserver.db"))
	if err != nil {
		return err
	}
	if answer != "ok" {
		fail("the restored database does not integrity_check: %s", answer)
	}
	return nil
}

// inspectErasureHeld checks the erased account and its messages did not come back: both were in the backup
// (which predates the erasure), so only the startup replay removes them (drill 2).
func (d *drill) inspectErasureHeld(r *rState, fail func(string, ...any)) error {
	if alive, who, err := authenticated(r.victimToken); err != nil {
		return err
	} else if alive {
		fail("the erased account %s is authenticated again after the restore: the startup replay did not erase it", who)
	}
	count, err := messageCount(r.token, r.text.ID)
	if err != nil {
		return err
	}
	if count != 0 {
		fail("the restored channel shows %d message(s) after the restore; the erased account's %d were restored and not removed again",
			count, victimMessages)
	}
	return nil
}

func (d *drill) inspectPostBackupDataGone(r *rState, fail func(string, ...any)) error {
	if alive, who, err := authenticated(r.newcomer); err != nil {
		return err
	} else if alive {
		fail("the account created after the backup (%s) is still authenticated after the restore — restoring did not roll it back", who)
	}
	return nil
}

// inspectAuditTrail checks the audit trail says what happened, including the replay under the marker's own
// token, the only link between the erase and the erasure the operator cannot see (the account is gone). Where
// each row lives is the assertion, in different databases by design: the restore writes backup_restore into
// the live database then overwrites that file with the backup, so the row survives only in the pre-restore
// safety copy (admin/handlers_backup_test.go asserts it), while the replay runs after the boot and lands in
// the restored database.
func (d *drill) inspectAuditTrail(r *rState, fail func(string, ...any)) error {
	rows, err := auditLog(r.token)
	if err != nil {
		return err
	}
	if !hasAuditRow(rows, "account_erasure_replayed", r.markers.token) {
		fail("the live audit log holds no account_erasure_replayed entry carrying the marker token %s", shortToken(r.markers.token))
	}
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return err
	}
	if len(copies) == 0 {
		fail("there is no pre-restore safety copy to hold the backup_restore entry the restore wrote before overwriting the live database")
	}
	for _, name := range copies {
		inside, err := auditRowsOf(filepath.Join(d.backupDir(), name))
		if err != nil {
			return err
		}
		if !hasAuditRow(inside, "backup_restore", "") {
			fail("the pre-restore safety copy %s holds no backup_restore entry, so nothing anywhere records that the restore happened", name)
		}
	}
	return nil
}

// inspectUploadGone checks V's file is gone from disk: the replay removes files as well as rows, and a
// restored upload whose row is gone is an orphan.
func (d *drill) inspectUploadGone(r *rState, fail func(string, ...any)) error {
	if _, err := os.Stat(filepath.Join(d.uploadsDir(), r.victimFile)); err == nil {
		fail("the erased account's upload file is still on disk at uploads/%s after the restore: the replay removed the row and not the file", r.victimFile)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// inspectMarkerSurvived checks the marker survived the restore, the one thing it cannot roll back; a replay
// that consumed it would erase V once and leave the next restore to resurrect it.
func (d *drill) inspectMarkerSurvived(r *rState, fail func(string, ...any)) error {
	state, err := readMarkers(d.dataDir())
	if err != nil {
		return err
	}
	if state.count != 1 {
		fail("the marker file holds %d marker(s) after the replay, want the one it held before", state.count)
	}
	if state.token != r.markers.token {
		fail("the marker file's token changed across the restore (%s -> %s)", shortToken(r.markers.token), shortToken(state.token))
	}
	return nil
}

func preRestoreCopies(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre_restore_") && filepath.Ext(e.Name()) == ".db" {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	return names, nil
}

// hasAuditRow reports whether the audit log holds an action, under a subject token when given; the token ties
// a replayed erasure to its marker.
func hasAuditRow(rows []auditRow, action, token string) bool {
	for _, row := range rows {
		if row.Action != action {
			continue
		}
		if token == "" || row.SubjectToken == token {
			return true
		}
	}
	return false
}

// auditRowsOf reads audit_log out of a database file: the pre-restore safety copy is served by no server, so
// the audit endpoint cannot see the row that exists only inside it.
func auditRowsOf(path string) ([]auditRow, error) {
	db, err := openSQLite(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(context.Background(),
		"SELECT action, COALESCE(detail, ''), COALESCE(subject_token, '') FROM audit_log")
	if err != nil {
		return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
	}
	defer func() { _ = rows.Close() }()
	var out []auditRow
	for rows.Next() {
		var row auditRow
		if err := rows.Scan(&row.Action, &row.Detail, &row.SubjectToken); err != nil {
			return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
	}
	return out, nil
}

// saysHistoryGone reports whether a log says the erasure history is absent: one line naming the erasure
// markers and calling them missing. Two words in one line, not a literal phrase, because the expected
// behaviour is "a startup error that the history is absent", not a sentence.
func saysHistoryGone(log string) bool {
	for line := range strings.SplitSeq(log, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "erasure") &&
			(strings.Contains(lower, "missing") || strings.Contains(lower, "absent") || strings.Contains(lower, "gone")) {
			return true
		}
	}
	return false
}

func erasedPhrase(alive bool) string {
	if alive {
		return "BACK (the erasure did not survive the restore)"
	}
	return "still gone"
}

func shortToken(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12] + "…"
}

func tailExcerpt(tail string) string {
	const limit = 4096
	if len(tail) <= limit {
		return tail
	}
	return tail[len(tail)-limit:]
}
