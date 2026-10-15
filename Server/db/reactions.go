package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// MaxDistinctReactions is the most different emoji one message may carry.
const MaxDistinctReactions = 20

// AddReaction inserts a reaction. Returns an error on duplicate (same
// user+emoji+message). A new emoji on a message that already holds
// MaxDistinctReactions different ones is refused with ErrReactionLimit; an
// emoji already on the message is still accepted. The cap test is part of the
// insert statement, so racing first-time emoji cannot both pass it.
func (d *DB) AddReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	res, err := d.q.AddReactionCapped(ctx, dbgen.AddReactionCappedParams{
		MessageID:   messageID,
		UserID:      userID,
		Emoji:       emoji,
		MaxDistinct: MaxDistinctReactions,
	})
	if err != nil {
		return fmt.Errorf("AddReaction: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("AddReaction rows affected: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("AddReaction: %w", ErrReactionLimit)
	}
	return nil
}
