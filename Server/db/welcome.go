package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// WelcomeRow is the welcome row InsertWelcomeRow wrote: a kind-8 message whose
// author is the member who just joined (WP 8.6).
type WelcomeRow struct {
	MessageID int64
	ChannelID int64
	UserID    int64
	Content   string
	Timestamp string
}

// InsertWelcomeRow writes a welcome row (kind 8) into channelID authored by
// userID and advances that member's read state past it, in one transaction, so
// the row is not unread for the person it greets. content is the English
// fallback only an old client shows; a current client draws its own greeting.
func (d *DB) InsertWelcomeRow(ctx context.Context, channelID, userID int64, content string) (*WelcomeRow, error) {
	var out *WelcomeRow
	err := d.inWriteTx(ctx, "InsertWelcomeRow", func(q *dbgen.Queries) error {
		m, err := q.InsertWelcomeMessage(ctx, dbgen.InsertWelcomeMessageParams{
			ChannelID: channelID,
			UserID:    userID,
			Content:   content,
		})
		if err != nil {
			return fmt.Errorf("insert welcome row: %w", err)
		}
		advanceAuthorReadState(ctx, q, userID, channelID, m.ID)
		out = &WelcomeRow{
			MessageID: m.ID, ChannelID: m.ChannelID, UserID: m.UserID,
			Content: m.Content, Timestamp: m.Timestamp,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
