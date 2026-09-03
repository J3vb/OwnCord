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
	// did not. A pending marker left by a crash is resolved on the next open
	// by whether the account still exists.
	MarkerPending  = "pending"
	MarkerRecorded = "recorded"
)

// markerSchema is the deletion_markers table, the HP-4 deletion_markers
// draft plus the state column the pending/recorded protocol needs.
const markerSchema = `
CREATE TABLE IF NOT EXISTS deletion_markers (
    subject_token TEXT    PRIMARY KEY,
    scope         TEXT    NOT NULL CHECK (scope IN ('account', 'messages')),
    channel_id    INTEGER,
    cutoff        TEXT,
    state         TEXT    NOT NULL DEFAULT 'recorded' CHECK (state IN ('pending', 'recorded')),
    erased_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    replays       INTEGER NOT NULL DEFAULT 0,
    last_replay   TEXT
);`

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
	if _, err := sqlDB.Exec(markerSchema); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("marker store: schema: %w", err)
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
// erasure transaction runs and returns its token, and whether this call
// created it (false when a marker for the subject already exists — a
// replay of a recorded marker, or a retry after a crash).
func (m *MarkerStore) RecordPendingAccount(ctx context.Context, userID int64) (string, bool, error) {
	token := m.SubjectToken(userID)
	res, err := m.sqlDB.ExecContext(ctx,
		`INSERT OR IGNORE INTO deletion_markers (subject_token, scope, state) VALUES (?, 'account', 'pending')`, token)
	if err != nil {
		return "", false, fmt.Errorf("marker store: record pending: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", false, fmt.Errorf("marker store: record pending rows: %w", err)
	}
	return token, n == 1, nil
}

// ConfirmAccount marks the subject's marker recorded: the erasure committed.
func (m *MarkerStore) ConfirmAccount(ctx context.Context, token string) error {
	if _, err := m.sqlDB.ExecContext(ctx,
		`UPDATE deletion_markers SET state = 'recorded', erased_at = datetime('now') WHERE subject_token = ? AND state = 'pending'`, token); err != nil {
		return fmt.Errorf("marker store: confirm: %w", err)
	}
	return nil
}

// DiscardPending removes a pending marker whose erasure did not commit.
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
	// Erased counts accounts a recorded marker found present and erased again.
	Erased int
	// Confirmed counts pending markers whose account was already gone (the
	// erasure had committed before a crash) and are now recorded.
	Confirmed int
	// Discarded counts pending markers whose account still existed (the
	// erasure never committed) and were dropped.
	Discarded int
}

// ReplayAccounts applies the account markers to the main database (data-
// lifecycle O4 A5): every account whose id hashes to a recorded marker is
// erased again through erase — after a restore, that is the resurrected
// subject. Pending markers are resolved first by whether their account
// exists: gone means the erasure committed (confirm), present means it did
// not (discard). erase must be the full erasure (db.EraseAccount plus the
// file half), given the marker's token so the audit rows unlink to it.
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
		case mk.State == MarkerPending && !exists:
			if err := m.ConfirmAccount(ctx, token); err != nil {
				return rep, err
			}
			rep.Confirmed++
		case mk.State == MarkerPending && exists:
			if err := m.DiscardPending(ctx, token); err != nil {
				return rep, err
			}
			rep.Discarded++
		case exists:
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
// cutoff the policy reached. cutoff is stored in SQLite's UTC layout.
func (m *MarkerStore) RecordMessagesSweep(ctx context.Context, channelID int64, cutoff string) error {
	if _, err := m.sqlDB.ExecContext(ctx,
		`INSERT INTO deletion_markers (subject_token, scope, channel_id, cutoff, state)
		 VALUES (?, 'messages', ?, ?, 'recorded')
		 ON CONFLICT(subject_token) DO UPDATE SET cutoff = MAX(cutoff, excluded.cutoff), erased_at = datetime('now')`,
		m.MessagesToken(channelID), channelID, cutoff); err != nil {
		return fmt.Errorf("marker store: record messages sweep: %w", err)
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
