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

// MarkerStore is the durable deletion-marker file (B4-10, BPR-053; HP-4
// decision 3): data/erasure/markers.sqlite, a second SQLite database that
// lives outside the file a backup restore overwrites. Every account erasure
// records a marker here; on every open the server replays the markers
// against the main database and erases again whatever a restored backup
// brought back. A marker names its subject only through
// SubjectToken — HMAC-SHA256 under the erasure key kept beside totp.key —
// so the file identifies nobody without the key.
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
}

// Marker scopes and states.
const (
	MarkerScopeAccount  = "account"
	MarkerScopeMessages = "messages"
	// MarkerPending is written before the erasure transaction and resolved
	// after it: confirmed when the transaction committed, discarded when it
	// was refused. A pending marker left by a crash is applied on the next
	// open like a recorded one (ReplayAccounts): whether the transaction
	// committed cannot be read off the main database, since a restore
	// reverts it, and the request the marker records was authorised.
	MarkerPending  = "pending"
	MarkerRecorded = "recorded"
)

// Sequence floors the marker file keeps (RaiseSequenceFloor): the
// AUTOINCREMENT counters of the tables whose ids the markers name.
const (
	SequenceFloorUsers    = "users"
	SequenceFloorChannels = "channels"
)

// markerSchema is the marker file: deletion_markers, the HP-4
// deletion_markers draft plus the state column the pending/recorded
// protocol needs, and sequence_floors, the AUTOINCREMENT counters below
// which no id may be handed out again (RaiseSequenceFloor).
var markerSchema = []string{`
CREATE TABLE IF NOT EXISTS deletion_markers (
    subject_token TEXT    PRIMARY KEY,
    scope         TEXT    NOT NULL CHECK (scope IN ('account', 'messages')),
    channel_id    INTEGER,
    cutoff        TEXT,
    state         TEXT    NOT NULL DEFAULT 'recorded' CHECK (state IN ('pending', 'recorded')),
    erased_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    replays       INTEGER NOT NULL DEFAULT 0,
    last_replay   TEXT
);`, `
CREATE TABLE IF NOT EXISTS sequence_floors (
    name TEXT    PRIMARY KEY,
    seq  INTEGER NOT NULL
);`, `
CREATE TABLE IF NOT EXISTS floor_probes (
    name      TEXT PRIMARY KEY,
    probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);`}

// OpenMarkerStore opens (creating if absent) the marker file at path with
// the given 32-byte erasure key and applies its schema. The parent directory
// is created. ":memory:" is accepted for tests.
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
	return &MarkerStore{sqlDB: sqlDB, key: append([]byte(nil), key...), path: path}, nil
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
// HMAC-SHA256(key, "account:" || decimal user id). The same token is what
// the erasure leaves in audit_log.subject_token.
func (m *MarkerStore) SubjectToken(userID int64) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte("account:"))
	mac.Write([]byte(strconv.FormatInt(userID, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// RecordPendingAccount writes a pending account marker for userID before the
// erasure transaction runs — together with the users sequence floor
// (usersSeq is DB.SequenceValue for the users table, the id space as it
// stands with the subject in it) — and returns its token, and whether this
// call created the marker (false when one for the subject already exists —
// a replay of a recorded marker, or a retry after a crash).
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

// RaiseSequenceFloor records that table's AUTOINCREMENT counter stood at
// seq when a marker was written: a restore rolls sqlite_sequence back with
// the rest of the file, and the next row would take an id a marker still
// names — the first account to inherit an erased user's id would be erased
// by that user's marker on the next open. Every open re-applies the floors
// to the main database (DB.RaiseSequences) before the markers are
// replayed, so an id is never handed out twice across restored timelines.
// A floor only ever moves up.
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

// SequenceFloorProbeCeiling bounds LocateSequenceFloor's search. A marker
// names its subject by a one-way token, so recovering the id means hashing
// candidates until every marker is accounted for; the probe stops there,
// which on any real id space is long before this. A store whose markers
// name an id beyond it cannot be resolved by probing, and the caller is
// told rather than left with a floor that only looks safe.
const SequenceFloorProbeCeiling = 1 << 24

// LocateSequenceFloor recovers the floor a marker file written before
// sequence_floors existed never recorded: the highest id its markers name,
// found by hashing candidates and looking them up. The live counter cannot
// supply it — a restore can have rolled it back below an id a marker still
// names, which is the case the floors exist to defend against — and neither
// can a floor row that is present but older than some marker, so the
// markers themselves are the only source. complete reports whether every
// marker of the table's scope was located; a false means the probe reached
// ceiling first and the floor it returns is a lower bound, not a safe one.
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

// FloorProbed reports whether a complete probe has already established
// this table's floor. Once one has, every marker then present is covered
// and every marker written since recorded its own floor, so the probe never
// has to run again — and, equally, a floor row alone is not evidence of
// that: a store can hold a floor written by a later erasure while an older
// marker still names a higher id.
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

// MarkFloorProbed records that a complete probe established this table's
// floor.
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

// DiscardPending removes a pending marker whose erasure was refused — the
// transaction returned an error, so nothing changed. Only the erasure that
// wrote the marker may discard it; a replay never does (ReplayAccounts).
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
		`SELECT subject_token, scope, channel_id, cutoff, state, erased_at, replays, last_replay
		   FROM deletion_markers ORDER BY erased_at, subject_token`)
	if err != nil {
		return nil, fmt.Errorf("marker store: list: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var out []DeletionMarker
	for rows.Next() {
		var mk DeletionMarker
		if err := rows.Scan(&mk.SubjectToken, &mk.Scope, &mk.ChannelID, &mk.Cutoff, &mk.State, &mk.ErasedAt, &mk.Replays, &mk.LastReplay); err != nil {
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

// ReplayAccounts applies the account markers to the main database (data-
// lifecycle O4 A5): every account whose id hashes to a marker is erased
// again through erase — after a restore, that is the resurrected subject.
// A pending marker is one an erasure wrote before its transaction and a
// crash left unresolved. Whether that transaction committed cannot be read
// off the main database — a restore reverts a commit, and a restore is
// exactly when the markers matter — so a pending marker whose account is
// present is applied like a recorded one and becomes recorded: the request
// it records was authorised before it was written (the erasure's preflight
// refuses first), and "done, then undone by a restore" and "never done"
// end the same way. A pending marker whose account is gone is confirmed.
// erase must be the full erasure (db.ReplayEraseAccount plus the file
// half), given the marker's token so the audit rows unlink to it, and must
// not apply the last-admin guard — a live-operation rule the erasure passed
// when it ran.
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

// MessagesToken is the unlinkable name of a channel's retention marker:
// hex of HMAC-SHA256(key, "messages:" || decimal channel id).
func (m *MarkerStore) MessagesToken(channelID int64) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte("messages:"))
	mac.Write([]byte(strconv.FormatInt(channelID, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// RecordMessagesSweep records that retention removed everything older than
// cutoff in channelID (B4-11): one marker per channel, its cutoff only ever
// moving forward, so a restore of an older backup re-sweeps to the newest
// cutoff the policy reached. cutoff is stored in SQLite's UTC layout. The
// channels sequence goes down with it as a floor (channelsSeq is
// DB.SequenceValue for the channels table), so a restore cannot hand the
// channel's id — and with it this marker — to a new channel.
func (m *MarkerStore) RecordMessagesSweep(ctx context.Context, channelID int64, cutoff string, channelsSeq int64) error {
	tx, err := m.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("marker store: record messages sweep: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO deletion_markers (subject_token, scope, channel_id, cutoff, state)
		 VALUES (?, 'messages', ?, ?, 'recorded')
		 ON CONFLICT(subject_token) DO UPDATE SET cutoff = MAX(cutoff, excluded.cutoff), erased_at = datetime('now')`,
		m.MessagesToken(channelID), channelID, cutoff); err != nil {
		return fmt.Errorf("marker store: record messages sweep: %w", err)
	}
	if err := raiseSequenceFloor(ctx, tx, SequenceFloorChannels, channelsSeq); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("marker store: record messages sweep commit: %w", err)
	}
	return nil
}

// ReplayMessages re-applies every messages marker: sweep is called with the
// channel and the marker's cutoff and must remove everything older than it
// (the retention sweep, pinned exempt), returning how many rows went. A
// marker for a channel that no longer exists is skipped. Returns the number
// of messages removed across all markers.
func (m *MarkerStore) ReplayMessages(ctx context.Context, sweep func(ctx context.Context, channelID int64, cutoff string) (int, error)) (int, error) {
	markers, err := m.Markers(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, mk := range markers {
		if mk.Scope != MarkerScopeMessages || mk.ChannelID == nil || mk.Cutoff == nil {
			continue
		}
		n, err := sweep(ctx, *mk.ChannelID, *mk.Cutoff)
		if err != nil {
			return total, fmt.Errorf("marker store: replay messages for channel %d: %w", *mk.ChannelID, err)
		}
		if n > 0 {
			slog.Warn("retention marker: messages present past the recorded cutoff, removed again", "channel_id", *mk.ChannelID, "messages", n)
			if _, err := m.sqlDB.ExecContext(ctx,
				`UPDATE deletion_markers SET replays = replays + 1, last_replay = datetime('now') WHERE subject_token = ?`, mk.SubjectToken); err != nil {
				return total, fmt.Errorf("marker store: count replay: %w", err)
			}
		}
		total += n
	}
	return total, nil
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
