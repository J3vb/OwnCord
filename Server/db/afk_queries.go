package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// GetAFKChannel returns the channel flagged AFK (migration 068), or nil.
func (d *DB) GetAFKChannel(ctx context.Context) (*Channel, error) {
	r, err := d.q.GetAFKChannel(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetAFKChannel: %w", err)
	}
	ch := channelFromFields(channelFields(r))
	return &ch, nil
}

// SetAFKChannel makes channelID the AFK channel, or clears the flag when channelID is
// nil, and returns the previously flagged id (nil when none).
// Read, clear and set share one writer transaction; idx_channels_afk backs it up, and
// the clear runs first because the index is checked per statement. The set only
// matches a live voice channel, else nothing commits and ErrNotFound is returned.
func (d *DB) SetAFKChannel(ctx context.Context, channelID *int64) (*int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("SetAFKChannel begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	var prev *int64

	old, err := q.GetAFKChannel(ctx)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return nil, fmt.Errorf("SetAFKChannel read: %w", err)
	default:
		id := old.ID
		prev = &id
	}
	if err := q.ClearAFKChannel(ctx); err != nil {
		return nil, fmt.Errorf("SetAFKChannel clear: %w", err)
	}
	if channelID != nil {
		n, err := q.SetChannelAFK(ctx, *channelID)
		if err != nil {
			return nil, fmt.Errorf("SetAFKChannel set: %w", err)
		}
		if n == 0 {
			return nil, fmt.Errorf("SetAFKChannel set: channel %d: %w", *channelID, ErrNotFound)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("SetAFKChannel commit: %w", err)
	}
	return prev, nil
}
