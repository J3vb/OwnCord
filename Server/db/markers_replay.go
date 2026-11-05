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
	"strconv"
)

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

// MessagesToken is the unlinkable name of a channel's retention marker:
// hex of HMAC-SHA256(key, "messages:" || decimal channel id).
func (m *MarkerStore) MessagesToken(channelID int64) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte("messages:"))
	mac.Write([]byte(strconv.FormatInt(channelID, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// RecordMessagesSweep records that retention removed everything older than
// cutoff in channelID: one marker per channel, its cutoff only moving forward,
// so restoring an older backup re-sweeps to the newest cutoff. cutoff is in
// SQLite's UTC layout. The channels sequence is recorded as a floor
// (channelsSeq is DB.SequenceValue for channels) so a restore cannot hand the
// channel's id, and this marker, to a new channel.
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

// ReplayMessages re-applies every messages marker: sweep removes everything in
// the channel older than the cutoff (the retention sweep, pinned exempt) and
// returns how many rows went. A marker for a vanished channel is skipped. It
// returns the total removed.
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
