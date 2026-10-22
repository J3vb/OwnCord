package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// GetAFKChannel returns the channel flagged AFK (migration 068), or nil when
// none is.
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

// SetAFKChannel makes channelID the AFK channel, or clears the flag when
// channelID is nil. The previously flagged channel's id is returned (nil when
// there was none). The read of the old flag, the clear and the set share one
// transaction on the single writer connection, and the partial unique index
// idx_channels_afk backs it up, so two callers can never leave two flagged
// rows. The clear runs before the set because the index is checked per
// statement.
//
// The set only matches a live voice channel; if the channel was deleted or
// archived after the caller validated it, nothing commits and ErrNotFound is
// returned.
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
