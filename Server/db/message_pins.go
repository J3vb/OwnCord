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

// PinEventWindow is how long a pin row suppresses another for the same message.
const PinEventWindow = 10 * time.Minute

// SetPinnedParams describes one pin or unpin. UserID and Username are the pinner; Now
// is the clock for the pin stamp and row window (zero means time.Now()).
type SetPinnedParams struct {
	MessageID int64
	Pinned    bool
	UserID    int64
	Username  string
	Now       time.Time
}

// PinEventRow is the kind-7 pin row SetMessagePinned wrote; its reply_to is the pinned message.
type PinEventRow struct {
	MessageID       int64
	ChannelID       int64
	UserID          int64
	Content         string
	Timestamp       string
	PinnedMessageID int64
}

// SetMessagePinned updates the pinned column and, when it pins a message not
// already pinned and no pin row for it (deleted or not) was written within
// PinEventWindow, writes a pin row (kind 7) in the same transaction and advances
// the pinner's read state past it. It returns that row, or nil when none was
// written. A failed row insert rolls the pin back; ErrNotFound if the message does not
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
			// Stamp pin time so GetPinnedMessages orders by recency; fixed-width nanoseconds keep
			// TEXT ordering right within a second.
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

// MaxPinnedMessages bounds the pins one query returns, keeping the IN (?,?,...) batch
// lookups under SQLite's bound-parameter limit.
const MaxPinnedMessages = 1000

// GetPinnedMessages returns up to MaxPinnedMessages+1 pins (the extra signals
// truncation), newest pin first.
func (d *DB) GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
		        m.mentions_everyone, m.kind
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0
		 ORDER BY m.pinned_at DESC, m.id DESC LIMIT ?`,
		channelID, MaxPinnedMessages+1,
	)
	if err != nil {
		return nil, fmt.Errorf("GetPinnedMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(withCachedReads(ctx), rows, requestingUserID)
}
