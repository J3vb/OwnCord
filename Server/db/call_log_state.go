package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// OpenCall is a live call log row as the call log worker reads it: where it
// is, who started it, and when it started and was last seen occupied. Times
// use the messages.timestamp layout.
type OpenCall struct {
	MessageID  int64
	ChannelID  int64
	AuthorID   int64
	StartedAt  string
	LastSeenAt string
}

// ListOpenCalls returns every live call, oldest first.
func (d *DB) ListOpenCalls(ctx context.Context) ([]OpenCall, error) {
	rows, err := d.q.ListOpenMessageCalls(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListOpenCalls: %w", err)
	}
	out := make([]OpenCall, 0, len(rows))
	for _, r := range rows {
		out = append(out, OpenCall{
			MessageID: r.MessageID, ChannelID: r.ChannelID, AuthorID: r.UserID,
			StartedAt: r.StartedAt, LastSeenAt: r.LastSeenAt,
		})
	}
	return out, nil
}

// GetOpenCall returns the channel's live call, or (nil, nil) when it has none.
func (d *DB) GetOpenCall(ctx context.Context, channelID int64) (*OpenCall, error) {
	r, err := d.q.GetOpenMessageCallByChannel(ctx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetOpenCall: %w", err)
	}
	return &OpenCall{
		MessageID: r.MessageID, ChannelID: r.ChannelID, AuthorID: r.UserID,
		StartedAt: r.StartedAt, LastSeenAt: r.LastSeenAt,
	}, nil
}

// AddCallParticipants records userIDs as participants of a call in one
// transaction. A user already recorded is left alone, and a user who no
// longer exists is skipped.
func (d *DB) AddCallParticipants(ctx context.Context, messageID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	return d.inWriteTx(ctx, "AddCallParticipants", func(q *dbgen.Queries) error {
		for _, uid := range userIDs {
			if err := q.InsertExistingMessageCallParticipant(ctx, dbgen.InsertExistingMessageCallParticipantParams{
				MessageID: messageID, UserID: uid,
			}); err != nil {
				return fmt.Errorf("insert participant: %w", err)
			}
		}
		return nil
	})
}

// TouchCall moves a live call's last_seen_at forward to seenAt. It never moves
// it back and does nothing for a call that has ended.
func (d *DB) TouchCall(ctx context.Context, messageID int64, seenAt string) error {
	if err := d.q.TouchMessageCall(ctx, dbgen.TouchMessageCallParams{
		LastSeenAt: seenAt, MessageID: messageID,
	}); err != nil {
		return fmt.Errorf("TouchCall: %w", err)
	}
	return nil
}

// GetCallInfo returns a call's block (times and participants), or (nil, nil)
// when the message has no call row.
func (d *DB) GetCallInfo(ctx context.Context, messageID int64) (*CallInfo, error) {
	ids := []int64{messageID}
	calls, err := d.q.GetMessageCallsByMessageIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("GetCallInfo: %w", err)
	}
	if len(calls) == 0 {
		return nil, nil
	}
	parts, err := d.q.GetMessageCallParticipantsByMessageIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("GetCallInfo participants: %w", err)
	}
	info := &CallInfo{StartedAt: calls[0].StartedAt, EndedAt: calls[0].EndedAt, Participants: []int64{}}
	for _, p := range parts {
		info.Participants = append(info.Participants, p.UserID)
	}
	return info, nil
}
