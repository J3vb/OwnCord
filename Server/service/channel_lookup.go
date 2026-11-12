package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// lookupChannel reads a channel for a request that must answer for it. A missing row is ErrNotFound; a
// store failure (including a cancelled or expired request context) is a logged ErrInternal, never a 404,
// so a client cannot mistake a transient fault for a deleted channel.
func lookupChannel(ctx context.Context, st channelGetter, id int64) (*db.Channel, error) {
	ch, err := st.GetChannel(ctx, id)
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			slog.DebugContext(ctx, "service: channel lookup cancelled", "err", err, "channel_id", id)
		case errors.Is(err, context.DeadlineExceeded):
			slog.WarnContext(ctx, "service: channel lookup timed out", "err", err, "channel_id", id)
		default:
			slog.ErrorContext(ctx, "service: channel lookup failed", "err", err, "channel_id", id)
		}
		return nil, fmt.Errorf("%w: failed to read channel: %w", ErrInternal, err)
	}
	if ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return ch, nil
}
