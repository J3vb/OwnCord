package db

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// ListUserMessageChannelsSince returns the ids of the channels that hold a
// live message by userID posted at or after since (a stored "YYYY-MM-DD
// HH:MM:SS" UTC timestamp), in ascending order. Direct and group-direct
// channels (both type 'dm') and archived channels are left out: a ban purge
// never reaches them, the same rule PurgeMessages applies per channel.
func (d *DB) ListUserMessageChannelsSince(ctx context.Context, userID int64, since string) ([]int64, error) {
	floor, err := d.firstIDAtOrAfter(ctx, since)
	if err != nil {
		return nil, fmt.Errorf("ListUserMessageChannelsSince: %w", err)
	}
	rows, err := d.reader.QueryContext(ctx,
		`SELECT DISTINCT m.channel_id
		 FROM messages m JOIN channels c ON c.id = m.channel_id
		 LEFT JOIN channels p ON p.id = c.parent_channel_id
		 WHERE m.user_id = ? AND m.id >= ? AND m.timestamp >= ? AND m.deleted = 0
		   AND c.type != 'dm' AND COALESCE(p.archived, c.archived) = 0
		 ORDER BY m.channel_id`,
		userID, floor, since,
	)
	if err != nil {
		return nil, fmt.Errorf("ListUserMessageChannelsSince: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ListUserMessageChannelsSince scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListUserMessageChannelsSince rows: %w", err)
	}
	return ids, nil
}

// PurgeUserChannelMessagesSince soft-deletes up to limit of userID's live
// messages in channelID posted at or after since (a stored "YYYY-MM-DD
// HH:MM:SS" UTC timestamp), newest first, in one writer transaction. It
// returns the ids this call moved, in descending order; a message already
// deleted, or deleted by a concurrent writer, is neither selected nor
// returned. Only messages.deleted changes, as in PurgeChannelMessages.
func (d *DB) PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}
	floor, err := d.firstIDAtOrAfter(ctx, since)
	if err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince: %w", err)
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM messages
		 WHERE channel_id = ? AND user_id = ? AND id >= ? AND timestamp >= ? AND deleted = 0 AND kind IN (0, 7, 8)
		 ORDER BY id DESC LIMIT ?`,
		channelID, userID, floor, since, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince select: %w", err)
	}
	var selected []any
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			rows.Close() //nolint:errcheck
			return nil, fmt.Errorf("PurgeUserChannelMessagesSince scan: %w", scanErr)
		}
		selected = append(selected, id)
	}
	rows.Close() //nolint:errcheck
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince rows: %w", err)
	}
	if len(selected) == 0 {
		return []int64{}, nil
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(selected)), ",")
	moved, err := tx.QueryContext(ctx,
		fmt.Sprintf(`UPDATE messages SET deleted = 1 WHERE id IN (%s) AND deleted = 0 AND kind IN (0, 7, 8) RETURNING id`, //nolint:gosec // G201: placeholder interpolation, not user input
			placeholders),
		selected...,
	)
	if err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince update: %w", err)
	}
	ids := make([]int64, 0, len(selected))
	for moved.Next() {
		var id int64
		if scanErr := moved.Scan(&id); scanErr != nil {
			moved.Close() //nolint:errcheck
			return nil, fmt.Errorf("PurgeUserChannelMessagesSince returning scan: %w", scanErr)
		}
		ids = append(ids, id)
	}
	moved.Close() //nolint:errcheck
	if err := moved.Err(); err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince returning rows: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeUserChannelMessagesSince commit: %w", err)
	}
	slices.Sort(ids)
	slices.Reverse(ids)
	return ids, nil
}
