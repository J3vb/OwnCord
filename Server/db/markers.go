package db

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
)

// MarkerStore is the durable deletion-marker file (data/erasure/markers.sqlite),
// a second SQLite database outside the file a backup restore overwrites. Every
// account erasure records a marker; on every open the server replays them and
// erases again whatever a restored backup brought back. A marker names its
// subject only through SubjectToken (HMAC-SHA256 under the erasure key kept
// beside totp.key), so the file identifies nobody without the key.
type MarkerStore struct {
	sqlDB *sql.DB
	key   []byte
	path  string
}

// DeletionMarker is one row of deletion_markers.
type DeletionMarker struct {
	SubjectToken string
	Scope        string
	ChannelID    *int64
	Cutoff       *string
	State        string
	ErasedAt     string
	Replays      int
	LastReplay   *string
	// ImportedCutoff is the newest cutoff swept under the channel's own window
	// (which reaches imported messages); nil if every sweep spared them.
	ImportedCutoff *string
}

// Marker scopes and states.
const (
	MarkerScopeAccount  = "account"
	MarkerScopeMessages = "messages"
	// MarkerPending is written before the erasure transaction and resolved after
	// it: confirmed on commit, discarded when refused. A pending marker left by a
	// crash is applied on the next open like a recorded one (ReplayAccounts),
	// because whether the transaction committed cannot be read off a restored
	// main database and the request was authorised.
	MarkerPending  = "pending"
	MarkerRecorded = "recorded"
)

// Sequence floors the marker file keeps (RaiseSequenceFloor): the
// AUTOINCREMENT counters of the tables whose ids the markers name.
const (
	SequenceFloorUsers    = "users"
	SequenceFloorChannels = "channels"
)

// markerSchema is the marker file: deletion_markers (with the state column the
// pending/recorded protocol needs), sequence_floors (AUTOINCREMENT counters
// below which no id may be handed out again) and marker_meta, which binds the
// file to one erasure key (bindMarkerKey).
var markerSchema = []string{`
CREATE TABLE IF NOT EXISTS deletion_markers (
    subject_token TEXT    PRIMARY KEY,
    scope         TEXT    NOT NULL CHECK (scope IN ('account', 'messages')),
    channel_id    INTEGER,
    cutoff        TEXT,
    state         TEXT    NOT NULL DEFAULT 'recorded' CHECK (state IN ('pending', 'recorded')),
    erased_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    replays       INTEGER NOT NULL DEFAULT 0,
    last_replay   TEXT,
    imported_cutoff TEXT
);`, `
CREATE TABLE IF NOT EXISTS sequence_floors (
    name TEXT    PRIMARY KEY,
    seq  INTEGER NOT NULL
);`, `
CREATE TABLE IF NOT EXISTS floor_probes (
    name      TEXT PRIMARY KEY,
    probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);`, `
CREATE TABLE IF NOT EXISTS marker_meta (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);`}

// markerKeyFingerprintName is the marker_meta row binding a marker file to the
// erasure key its tokens were computed under. Nothing else in the file is
// key-derived, so a regenerated or swapped key would make every token miss and
// the replay silently erase nothing; the fingerprint makes that loud.
const markerKeyFingerprintName = "erasure-key-fingerprint"

// markerKeyFingerprint names the key without revealing it: hex of
// HMAC-SHA256(key, "owncord-marker-fingerprint"), which shares no preimage
// with SubjectToken or MessagesToken.
func markerKeyFingerprint(key []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("owncord-marker-fingerprint"))
	return hex.EncodeToString(mac.Sum(nil))
}

// fingerprintPrefix is the part of a fingerprint operator messages print;
// bounded so a corrupt row cannot panic the branch that reports it.
func fingerprintPrefix(fp string) string { return fp[:min(12, len(fp))] }

// ErrMarkerKeyMismatch is the refusal when the marker file records a different
// erasure key than the running one: a replay would erase nothing and a restored
// backup's accounts would serve, so start-up fails instead. The operator puts
// the original key back or blesses this one by hand (docs/security.md,
// "Erasure marker key"); the message names both.
var ErrMarkerKeyMismatch = errors.New("marker store: the marker file was created under a different erasure key")

// ErrMarkerKeyUnverified is the refusal when a marker file holds markers but
// records no key fingerprint. Adopting the present key would be the defect
// itself, since a regenerated key would silently become the key of record and
// void every marker; only the operator can bless it.
var ErrMarkerKeyUnverified = errors.New("marker store: the marker file holds markers but records no erasure key")

// OpenMarkerStore opens (creating if absent) the marker file at path with the
// 32-byte erasure key and applies its schema, creating the parent directory.
// ":memory:" is accepted for tests.
func OpenMarkerStore(path string, key []byte) (*MarkerStore, error) {
	if len(key) != sha256.Size {
		return nil, fmt.Errorf("marker store: key must be %d bytes, got %d", sha256.Size, len(key))
	}
	dsn := path
	if !isMemoryPath(path) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("marker store: creating %s: %w", filepath.Dir(path), err)
		}
		dsn = "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	}
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("marker store: open: %w", err)
	}
	sqlDB.SetMaxOpenConns(1)
	for _, ddl := range markerSchema {
		if _, err := sqlDB.Exec(ddl); err != nil {
			_ = sqlDB.Close()
			return nil, fmt.Errorf("marker store: schema: %w", err)
		}
	}
	if err := ensureImportedCutoffColumn(sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	if err := bindMarkerKey(sqlDB, path, markerKeyFingerprint(key)); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return &MarkerStore{sqlDB: sqlDB, key: append([]byte(nil), key...), path: path}, nil
}

// markerFileEscapeHatch is the warning every refusal below carries: deleting
// the file to get past it throws away more than the markers.
const markerFileEscapeHatch = "do not delete or move markers.sqlite to get past this: it also carries sequence_floors (without them an erased account's id is handed out again and its innocent new holder is erased by the old marker) and the account markers that keep the first-run setup gate closed against a restore of a pre-owner backup"

// bindMarkerKey holds the marker file to one erasure key. An empty file adopts
// the key it is first opened under. A file that already holds markers must
// prove the key: a recorded fingerprint must match, and one from before the
// fingerprint existed is refused rather than adopted (see
// ErrMarkerKeyUnverified). Both refusals are the operator's to resolve; the
// log names the statement that does it (docs/security.md).
func bindMarkerKey(sqlDB *sql.DB, path, fp string) error {
	var stored string
	err := sqlDB.QueryRow(`SELECT value FROM marker_meta WHERE name = ?`, markerKeyFingerprintName).Scan(&stored)
	switch {
	case err == nil:
		if hmac.Equal([]byte(stored), []byte(fp)) {
			return nil
		}
		slog.Error("erasure markers: this marker file was created under a different erasure key, so every marker in it names a subject the running key cannot match; the start-up replay would erase nothing and a restored backup would leave its erased accounts serving. Start with the erasure key this file was written under — or, if the key really was rotated and this one is now the key of record, repoint the file at it with the statement below, run against the marker file (docs/security.md, \"Erasure marker key\")",
			"marker_file", path,
			"file_key_fingerprint", fingerprintPrefix(stored),
			"running_key_fingerprint", fingerprintPrefix(fp),
			"restore_the_original_key", "put the erasure.key whose fingerprint begins "+fingerprintPrefix(stored)+" back at <data-dir>/erasure.key, or point OWNCORD_ERASURE_KEY at it",
			"adopt_this_key_instead", fmt.Sprintf("UPDATE marker_meta SET value = '%s' WHERE name = '%s';  -- only if the original key is gone for good: the markers become unmatchable, so a restore can resurrect the accounts they guard", fp, markerKeyFingerprintName),
			"warning", markerFileEscapeHatch)
		return fmt.Errorf("%w: %s", ErrMarkerKeyMismatch, path)
	case errors.Is(err, sql.ErrNoRows):
		var markers int
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM deletion_markers`).Scan(&markers); err != nil {
			return fmt.Errorf("marker store: counting markers for the key fingerprint: %w", err)
		}
		if markers > 0 {
			slog.Error("erasure markers: this marker file holds markers but records no erasure key — it was written before the key was bound to the file — and the running key cannot be proven to be the one those markers were computed under. Adopting it unchecked is the failure this check exists to stop: a key regenerated since would silently become the file's key of record, and every marker would stop matching the account it guards. Confirm this is the original erasure key, then bless the file with the statement below, run against the marker file (docs/security.md, \"Erasure marker key\")",
				"marker_file", path,
				"markers", markers,
				"running_key_fingerprint", fingerprintPrefix(fp),
				"acknowledge", fmt.Sprintf("INSERT INTO marker_meta (name, value) VALUES ('%s', '%s');", markerKeyFingerprintName, fp),
				"warning", markerFileEscapeHatch)
			return fmt.Errorf("%w: %s", ErrMarkerKeyUnverified, path)
		}
		if _, err := sqlDB.Exec(`INSERT INTO marker_meta (name, value) VALUES (?, ?)`, markerKeyFingerprintName, fp); err != nil {
			return fmt.Errorf("marker store: recording the key fingerprint: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("marker store: reading the key fingerprint: %w", err)
	}
}

// Close releases the file.
func (m *MarkerStore) Close() error {
	if m == nil || m.sqlDB == nil {
		return nil
	}
	return m.sqlDB.Close()
}

// Path returns where the markers live.
func (m *MarkerStore) Path() string { return m.path }

// SubjectToken is the unlinkable name of an account: hex of
// HMAC-SHA256(key, "account:" || decimal user id), also what the erasure
// leaves in audit_log.subject_token.
func (m *MarkerStore) SubjectToken(userID int64) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte("account:"))
	mac.Write([]byte(strconv.FormatInt(userID, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// RecordPendingAccount writes a pending account marker for userID before the
// erasure transaction, with the users sequence floor (usersSeq is
// DB.SequenceValue for users, taken with the subject still present). It
// returns the token and whether this call created the marker (false for a
// replay of a recorded marker or a retry after a crash).
func (m *MarkerStore) RecordPendingAccount(ctx context.Context, userID int64, usersSeq int64) (string, bool, error) {
	token := m.SubjectToken(userID)
	tx, err := m.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return "", false, fmt.Errorf("marker store: record pending: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	res, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO deletion_markers (subject_token, scope, state) VALUES (?, 'account', 'pending')`, token)
	if err != nil {
		return "", false, fmt.Errorf("marker store: record pending: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", false, fmt.Errorf("marker store: record pending rows: %w", err)
	}
	if err := raiseSequenceFloor(ctx, tx, SequenceFloorUsers, usersSeq); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, fmt.Errorf("marker store: record pending commit: %w", err)
	}
	return token, n == 1, nil
}

// RaiseSequenceFloor records that table's AUTOINCREMENT counter stood at seq
// when a marker was written. A restore rolls sqlite_sequence back, and the
// next row would take an id a marker still names, so the new holder would be
// erased by the old user's marker. Every open re-applies the floors
// (DB.RaiseSequences) before replaying markers. A floor only moves up.
func (m *MarkerStore) RaiseSequenceFloor(ctx context.Context, table string, seq int64) error {
	return raiseSequenceFloor(ctx, m.sqlDB, table, seq)
}

// markerExecer is what raiseSequenceFloor needs from *sql.DB and *sql.Tx.
type markerExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func raiseSequenceFloor(ctx context.Context, x markerExecer, table string, seq int64) error {
	if _, err := x.ExecContext(ctx,
		`INSERT INTO sequence_floors (name, seq) VALUES (?, ?)
		 ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq)`, table, seq); err != nil {
		return fmt.Errorf("marker store: sequence floor %s: %w", table, err)
	}
	return nil
}

// SequenceFloors returns every recorded floor by table name.
func (m *MarkerStore) SequenceFloors(ctx context.Context) (map[string]int64, error) {
	rows, err := m.sqlDB.QueryContext(ctx, `SELECT name, seq FROM sequence_floors`)
	if err != nil {
		return nil, fmt.Errorf("marker store: sequence floors: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	floors := make(map[string]int64)
	for rows.Next() {
		var name string
		var seq int64
		if err := rows.Scan(&name, &seq); err != nil {
			return nil, fmt.Errorf("marker store: scan sequence floor: %w", err)
		}
		floors[name] = seq
	}
	return floors, rows.Err()
}

// SequenceFloorProbeCeiling bounds LocateSequenceFloor's search. Markers name
// subjects by one-way token, so recovering an id means hashing candidates; a
// marker beyond the ceiling cannot be resolved and the caller is told rather
// than left with a floor that only looks safe.
const SequenceFloorProbeCeiling = 1 << 24

// LocateSequenceFloor recovers the floor a marker file written before
// sequence_floors existed never recorded: the highest id its markers name,
// found by hashing candidates. The live counter cannot supply it (a restore
// can roll it below a marker's id), nor can a floor row older than some
// marker. complete is false when the probe hit ceiling first, so the returned
// floor is only a lower bound.
//
// table is SequenceFloorUsers (account markers, keyed by SubjectToken) or
// SequenceFloorChannels (messages markers, keyed by MessagesToken).
func (m *MarkerStore) LocateSequenceFloor(ctx context.Context, table string, ceiling int64) (highest int64, complete bool, err error) {
	var scope string
	var token func(int64) string
	switch table {
	case SequenceFloorUsers:
		scope, token = MarkerScopeAccount, m.SubjectToken
	case SequenceFloorChannels:
		scope, token = MarkerScopeMessages, m.MessagesToken
	default:
		return 0, false, fmt.Errorf("marker store: no marker scope for sequence floor %q", table)
	}
	markers, err := m.Markers(ctx)
	if err != nil {
		return 0, false, err
	}
	wanted := make(map[string]struct{})
	for _, mk := range markers {
		if mk.Scope == scope {
			wanted[mk.SubjectToken] = struct{}{}
		}
	}
	if len(wanted) == 0 {
		return 0, true, nil
	}
	for id := int64(1); id <= ceiling; id++ {
		if _, ok := wanted[token(id)]; !ok {
			continue
		}
		highest = id
		delete(wanted, token(id))
		if len(wanted) == 0 {
			return highest, true, nil
		}
	}
	return highest, false, nil
}

// FloorProbed reports whether this table's floor is settled: a complete probe
// established it, or an operator acknowledged one established by hand (the
// row itself, inserted to unblock a store whose markers reach past the probe;
// docs/security.md, "Erasure marker sequence floors"). After that every marker
// present is covered and later ones recorded their own floor. A floor row
// alone is not evidence: a later erasure may have written it while an older
// marker names a higher id.
func (m *MarkerStore) FloorProbed(ctx context.Context, table string) (bool, error) {
	var one int
	err := m.sqlDB.QueryRowContext(ctx, `SELECT 1 FROM floor_probes WHERE name = ?`, table).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("marker store: floor probe %s: %w", table, err)
	}
	return true, nil
}

// MarkFloorProbed records that a complete probe established this table's floor.
func (m *MarkerStore) MarkFloorProbed(ctx context.Context, table string) error {
	if _, err := m.sqlDB.ExecContext(ctx,
		`INSERT OR IGNORE INTO floor_probes (name) VALUES (?)`, table); err != nil {
		return fmt.Errorf("marker store: record floor probe %s: %w", table, err)
	}
	return nil
}

// ConfirmAccount marks the subject's marker recorded: the erasure committed.
func (m *MarkerStore) ConfirmAccount(ctx context.Context, token string) error {
	if _, err := m.sqlDB.ExecContext(ctx,
		`UPDATE deletion_markers SET state = 'recorded', erased_at = datetime('now') WHERE subject_token = ? AND state = 'pending'`, token); err != nil {
		return fmt.Errorf("marker store: confirm: %w", err)
	}
	return nil
}

// DiscardPending removes a pending marker whose erasure was refused. Only the
// erasure that wrote the marker may discard it; a replay never does.
func (m *MarkerStore) DiscardPending(ctx context.Context, token string) error {
	if _, err := m.sqlDB.ExecContext(ctx,
		`DELETE FROM deletion_markers WHERE subject_token = ? AND state = 'pending'`, token); err != nil {
		return fmt.Errorf("marker store: discard pending: %w", err)
	}
	return nil
}

// Markers lists every marker, oldest first.
func (m *MarkerStore) Markers(ctx context.Context) ([]DeletionMarker, error) {
	rows, err := m.sqlDB.QueryContext(ctx,
		`SELECT subject_token, scope, channel_id, cutoff, state, erased_at, replays, last_replay, imported_cutoff
		   FROM deletion_markers ORDER BY erased_at, subject_token`)
	if err != nil {
		return nil, fmt.Errorf("marker store: list: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var out []DeletionMarker
	for rows.Next() {
		var mk DeletionMarker
		if err := rows.Scan(&mk.SubjectToken, &mk.Scope, &mk.ChannelID, &mk.Cutoff, &mk.State, &mk.ErasedAt, &mk.Replays, &mk.LastReplay, &mk.ImportedCutoff); err != nil {
			return nil, fmt.Errorf("marker store: scan: %w", err)
		}
		out = append(out, mk)
	}
	return out, rows.Err()
}

// ReplayReport is what one replay pass did.
type ReplayReport struct {
	// Erased counts accounts a marker — recorded, or still pending — found
	// present and erased; a pending one is recorded by it.
	Erased int
	// Confirmed counts pending markers whose account was already gone (the
	// erasure had committed before a crash) and are now recorded.
	Confirmed int
}

// ReplayAccounts applies the account markers to the main database: every
// account whose id hashes to a marker is erased again through erase (after a
// restore, the resurrected subject). A pending marker whose account is present
// is applied like a recorded one and becomes recorded: whether its transaction
// committed cannot be read off a database a restore reverts, the request was
// authorised before the marker was written, and "done then undone by a
// restore" and "never done" end the same way. A pending marker whose account
// is gone is confirmed. erase must be the full erasure (ReplayEraseAccount
// plus the file half), given the marker's token so audit rows unlink to it,
// and must not apply the last-admin guard.
func (m *MarkerStore) ReplayAccounts(ctx context.Context, users UserIDLister, erase func(ctx context.Context, userID int64, token string) error) (ReplayReport, error) {
	var rep ReplayReport
	markers, err := m.Markers(ctx)
	if err != nil {
		return rep, err
	}
	byToken := make(map[string]DeletionMarker, len(markers))
	for _, mk := range markers {
		if mk.Scope == MarkerScopeAccount {
			byToken[mk.SubjectToken] = mk
		}
	}
	if len(byToken) == 0 {
		return rep, nil
	}
	ids, err := users.ListUserIDs(ctx)
	if err != nil {
		return rep, err
	}
	present := make(map[string]int64, len(ids))
	for _, id := range ids {
		present[m.SubjectToken(id)] = id
	}
	for token, mk := range byToken {
		id, exists := present[token]
		switch {
		case !exists && mk.State == MarkerPending:
			if err := m.ConfirmAccount(ctx, token); err != nil {
				return rep, err
			}
			rep.Confirmed++
		case !exists:
		case mk.State == MarkerPending:
			slog.Warn("erasure marker: pending marker's account present in the database, erasing", "user_id", id)
			if err := erase(ctx, id, token); err != nil {
				return rep, fmt.Errorf("marker store: replay for user %d: %w", id, err)
			}
			if err := m.ConfirmAccount(ctx, token); err != nil {
				return rep, err
			}
			rep.Erased++
		default:
			slog.Warn("erasure marker: erased account present in the database, erasing again", "user_id", id, "replays", mk.Replays)
			if err := erase(ctx, id, token); err != nil {
				return rep, fmt.Errorf("marker store: replay for user %d: %w", id, err)
			}
			if _, err := m.sqlDB.ExecContext(ctx,
				`UPDATE deletion_markers SET replays = replays + 1, last_replay = datetime('now') WHERE subject_token = ?`, token); err != nil {
				return rep, fmt.Errorf("marker store: count replay: %w", err)
			}
			rep.Erased++
		}
	}
	return rep, nil
}

// HasAccountMarkers reports whether the file holds any account marker. One
// proves the installation was set up and an account erased, and it survives a
// restore of a backup taken before the first owner existed
// (ErasureService.ReplayMarkers).
func (m *MarkerStore) HasAccountMarkers(ctx context.Context) (bool, error) {
	var one int
	err := m.sqlDB.QueryRowContext(ctx,
		`SELECT 1 FROM deletion_markers WHERE scope = ? LIMIT 1`, MarkerScopeAccount).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("marker store: account markers: %w", err)
	}
	return true, nil
}

// UserIDLister lists every users.id; *DB satisfies it.
type UserIDLister interface {
	ListUserIDs(ctx context.Context) ([]int64, error)
}

// ListUserIDs returns every user id, ascending.
func (d *DB) ListUserIDs(ctx context.Context) ([]int64, error) {
	rows, err := d.reader.QueryContext(ctx, `SELECT id FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("ListUserIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ListUserIDs scan: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ErrMarkerKeyMissing is returned by callers that need a marker store and
// have none.
var ErrMarkerKeyMissing = errors.New("erasure markers unavailable")
