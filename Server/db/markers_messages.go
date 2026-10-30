package db

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strconv"
)

// ensureImportedCutoffColumn adds deletion_markers.imported_cutoff to a marker
// file created before it existed. Markers already in such a file keep a NULL
// there, which replays as "imported messages spared".
func ensureImportedCutoffColumn(sqlDB *sql.DB) error {
	var n int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('deletion_markers') WHERE name = 'imported_cutoff'`).Scan(&n); err != nil {
		return fmt.Errorf("marker store: inspect schema: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := sqlDB.Exec(`ALTER TABLE deletion_markers ADD COLUMN imported_cutoff TEXT`); err != nil {
		return fmt.Errorf("marker store: add imported_cutoff: %w", err)
	}
	return nil
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
// cutoff in channelID: one marker per channel, its cutoff only ever
// moving forward, so a restore of an older backup re-sweeps to the newest
// cutoff the policy reached. cutoff is stored in SQLite's UTC layout. The
// includeImported records that the sweep ran under the channel's own window and
// so reached Discord-imported messages; the marker keeps the newest such cutoff
// apart from the general one, because a later server-wide sweep has a newer
// cutoff that never touched them. The
// channels sequence goes down with it as a floor (channelsSeq is
// DB.SequenceValue for the channels table), so a restore cannot hand the
// channel's id — and with it this marker — to a new channel.
func (m *MarkerStore) RecordMessagesSweep(ctx context.Context, channelID int64, cutoff string, channelsSeq int64, includeImported bool) error {
	var importedCutoff *string
	if includeImported {
		importedCutoff = &cutoff
	}
	tx, err := m.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("marker store: record messages sweep: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO deletion_markers (subject_token, scope, channel_id, cutoff, state, imported_cutoff)
		 VALUES (?, 'messages', ?, ?, 'recorded', ?)
		 ON CONFLICT(subject_token) DO UPDATE SET cutoff = MAX(cutoff, excluded.cutoff), erased_at = datetime('now'),
		   imported_cutoff = CASE WHEN excluded.imported_cutoff IS NULL THEN imported_cutoff
		                          WHEN imported_cutoff IS NULL THEN excluded.imported_cutoff
		                          ELSE MAX(imported_cutoff, excluded.imported_cutoff) END`,
		m.MessagesToken(channelID), channelID, cutoff, importedCutoff); err != nil {
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
// (the retention sweep, pinned exempt), returning how many rows went. It runs
// once with includeImported false for the marker's cutoff, then, for a marker
// that recorded a sweep under the channel's own window, once more with
// includeImported true for that newer-or-equal imported cutoff. A
// marker for a channel that no longer exists is skipped. Returns the number
// of messages removed across all markers.
func (m *MarkerStore) ReplayMessages(ctx context.Context, sweep func(ctx context.Context, channelID int64, cutoff string, includeImported bool) (int, error)) (int, error) {
	markers, err := m.Markers(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, mk := range markers {
		if mk.Scope != MarkerScopeMessages || mk.ChannelID == nil || mk.Cutoff == nil {
			continue
		}
		n, err := sweep(ctx, *mk.ChannelID, *mk.Cutoff, false)
		if err == nil && mk.ImportedCutoff != nil {
			var more int
			more, err = sweep(ctx, *mk.ChannelID, *mk.ImportedCutoff, true)
			n += more
		}
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
