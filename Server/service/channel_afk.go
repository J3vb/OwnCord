package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── AFK channel ──────────────────────────────────────────────────

// AFKStore is the persistence slice behind ChannelService.SetAFKChannel.
// SetAFKChannel reads the old flag, clears it and sets the new one in one
// transaction and returns the previously flagged channel id (nil for none).
type AFKStore interface {
	GetAFKChannel(ctx context.Context) (*db.Channel, error)
	SetAFKChannel(ctx context.Context, channelID *int64) (*int64, error)
}

// AFKChange is the committed outcome of SetAFKChannel: the channel that lost
// the flag and the one that gained it. Either may be nil, and both are nil
// when nothing changed. The caller broadcasts channel_update for each.
type AFKChange struct {
	Previous *db.Channel
	Current  *db.Channel
}

// SetAFKChannel flags channelID as the server's AFK channel, or clears the
// flag when channelID is nil. Only a live voice channel qualifies: text,
// announcement and archived channels answer ErrBadRequest, and a missing or
// DM channel answers ErrNotFound. The clear of the old flag and the set of the
// new one are one transaction, audited as afk_channel_change. The rows handed
// back are re-read on an uncancellable tail, because the flag has committed
// and the caller must still be able to tell connected clients.
func (s *ChannelService) SetAFKChannel(ctx context.Context, actorID int64, channelID *int64) (AFKChange, error) {
	if s.afk == nil {
		return AFKChange{}, fmt.Errorf("%w: afk channel storage unavailable", ErrInternal)
	}
	var target *db.Channel
	if channelID != nil {
		ch, err := s.ResolveGuildChannel(ctx, *channelID)
		if err != nil {
			return AFKChange{}, err
		}
		if ch.Type != "voice" {
			return AFKChange{}, fmt.Errorf("only a voice channel can be the AFK channel%.0w", ErrBadRequest)
		}
		if ch.Archived {
			return AFKChange{}, fmt.Errorf("an archived channel cannot be the AFK channel%.0w", ErrBadRequest)
		}
		target = ch
	}

	prevID, err := s.afk.SetAFKChannel(ctx, channelID)
	if errors.Is(err, db.ErrNotFound) {
		return AFKChange{}, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if err != nil {
		return AFKChange{}, fmt.Errorf("%w: failed to set afk channel: %w", ErrInternal, err)
	}
	if sameChannelID(prevID, channelID) {
		return AFKChange{}, nil
	}

	tail := context.WithoutCancel(ctx)
	var change AFKChange
	if prevID != nil {
		prev, err := s.st.GetChannel(tail, *prevID)
		if err != nil {
			return AFKChange{}, fmt.Errorf("%w: failed to fetch previous afk channel: %w", ErrInternal, err)
		}
		change.Previous = prev
	}
	if target != nil {
		cur, err := s.st.GetChannel(tail, target.ID)
		if err != nil || cur == nil {
			return AFKChange{}, fmt.Errorf("%w: failed to fetch afk channel: %w", ErrInternal, err)
		}
		change.Current = cur
	}

	detail := "cleared the AFK channel"
	if target != nil {
		detail = fmt.Sprintf("set #%s as the AFK channel", target.Name)
	}
	slog.Info("afk channel changed", "actor_id", actorID, "channel_id", channelID)
	var targetID int64
	if target != nil {
		targetID = target.ID
	}
	db.WriteAudit(tail, s.st, actorID, "afk_channel_change", "channel", targetID, detail)
	return change, nil
}

func sameChannelID(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
