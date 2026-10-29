package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// PinEventWindow is how long a pin row suppresses another for the same
// message: pin, unpin and pin again inside it writes one row.
const PinEventWindow = 10 * time.Minute

// SetPinnedParams describes one pin or unpin. UserID and Username are the
// pinner, who becomes the author of the pin row. Now is the clock for the pin
// stamp and the row window; the zero value means time.Now().
type SetPinnedParams struct {
	MessageID int64
	Pinned    bool
	UserID    int64
	Username  string
	Now       time.Time
}

// PinEventRow is the pin row SetMessagePinned wrote: a kind-7 message whose
// reply_to is the pinned message.
type PinEventRow struct {
	MessageID       int64
	ChannelID       int64
	UserID          int64
	Content         string
	Timestamp       string
	PinnedMessageID int64
}

// SetMessagePinned updates the pinned column on a message and, when it pins a
// message that was not already pinned and no pin row for it, deleted or not, was written in
// the last PinEventWindow, writes a pin row (kind 7) in the same transaction and
// advances the pinner's read state past it. It returns that row, or nil when
// none was written (an unpin, a re-pin, or a pin inside the window). A failed
// row insert rolls the pin back. Returns ErrNotFound if the message does not
// exist or is deleted.
func (d *DB) SetMessagePinned(ctx context.Context, p SetPinnedParams) (*PinEventRow, error) {
	now := p.Now
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()
	var out *PinEventRow
	err := d.inWriteTx(ctx, "SetMessagePinned", func(q *dbgen.Queries) error {
		target, err := q.GetMessage(ctx, p.MessageID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("message %d: %w", p.MessageID, ErrNotFound)
			}
			return fmt.Errorf("get message: %w", err)
		}
		wasPinned := target.Pinned != 0

		var pinnedAt *string
		if p.Pinned {
			// Stamp pin time so GetPinnedMessages can order by recency. Fixed-width
			// nanosecond precision keeps lexicographic TEXT ordering correct even
			// for two pins in the same second.
			t := now.Format("2006-01-02 15:04:05.000000000")
			pinnedAt = &t
		}
		res, err := q.SetMessagePinned(ctx, dbgen.SetMessagePinnedParams{
			Pinned:   b2i64(p.Pinned),
			PinnedAt: pinnedAt,
			ID:       p.MessageID,
		})
		if err != nil {
			return fmt.Errorf("update: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return fmt.Errorf("message %d: %w", p.MessageID, ErrNotFound)
		}
		if !p.Pinned || wasPinned {
			return nil
		}
		cutoff := now.Add(-PinEventWindow).Format(dbtime.SQLiteLayout)
		recent, err := q.RecentPinEventExists(ctx, dbgen.RecentPinEventExistsParams{
			ReplyTo: &p.MessageID, Timestamp: cutoff,
		})
		if err != nil {
			return fmt.Errorf("recent pin row: %w", err)
		}
		if recent != 0 {
			return nil
		}
		m, err := q.InsertPinEventMessage(ctx, dbgen.InsertPinEventMessageParams{
			ChannelID: target.ChannelID,
			UserID:    p.UserID,
			Content:   p.Username + " pinned a message to this channel.",
			ReplyTo:   &p.MessageID,
		})
		if err != nil {
			return fmt.Errorf("insert pin row: %w", err)
		}
		advanceAuthorReadState(ctx, q, p.UserID, target.ChannelID, m.ID)
		out = &PinEventRow{
			MessageID: m.ID, ChannelID: m.ChannelID, UserID: m.UserID,
			Content: m.Content, Timestamp: m.Timestamp, PinnedMessageID: p.MessageID,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
