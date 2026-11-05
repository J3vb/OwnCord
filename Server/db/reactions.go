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

// RemoveReaction deletes a reaction. Returns an error if it does not exist.
func (d *DB) RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	res, err := d.q.RemoveReaction(ctx, dbgen.RemoveReactionParams{
		MessageID: messageID,
		UserID:    userID,
		Emoji:     emoji,
	})
	if err != nil {
		return fmt.Errorf("RemoveReaction: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("RemoveReaction: reaction: %w", ErrNotFound)
	}
	return nil
}

// GetReactions returns aggregated reaction counts for a message; MeReacted is
// always false here.
func (d *DB) GetReactions(ctx context.Context, messageID int64) ([]ReactionCount, error) {
	rows, err := d.q.GetReactionCounts(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("GetReactions: %w", err)
	}
	counts := make([]ReactionCount, 0, len(rows))
	for _, r := range rows {
		counts = append(counts, ReactionCount{Emoji: r.Emoji, Count: int(r.Count)})
	}
	return counts, nil
}

// MaxReactionUsers bounds the who-reacted list; the tooltip names only a
// handful, so the query is capped rather than paginated.
const MaxReactionUsers = 100

// GetReactionUsers returns up to limit reactors for one (message, emoji) pair,
// oldest reaction first. limit is clamped to MaxReactionUsers.
func (d *DB) GetReactionUsers(ctx context.Context, messageID int64, emoji string, limit int) ([]ReactionUser, error) {
	if limit <= 0 || limit > MaxReactionUsers {
		limit = MaxReactionUsers
	}
	rows, err := d.q.GetReactionUsers(ctx, dbgen.GetReactionUsersParams{
		MessageID: messageID,
		Emoji:     emoji,
		Limit:     int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("GetReactionUsers: %w", err)
	}
	users := make([]ReactionUser, 0, len(rows))
	for _, r := range rows {
		users = append(users, ReactionUser{ID: r.ID, Username: r.Username, Avatar: r.Avatar})
	}
	return users, nil
}

// getReactionsBatch returns aggregated reactions for multiple messages.
func (d *DB) getReactionsBatch(ctx context.Context, msgIDs []int64, requestingUserID int64) (map[int64][]ReactionInfo, error) {
	if len(msgIDs) == 0 {
		return map[int64][]ReactionInfo{}, nil
	}

	rows, err := d.queryCached(ctx,
		`SELECT r.message_id, r.emoji, COUNT(*) as cnt,
		        MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) as me
		 FROM reactions r
		 WHERE r.message_id IN (SELECT value FROM json_each(?))
		 GROUP BY r.message_id, r.emoji`,
		requestingUserID, idsJSON(msgIDs),
	)
	if err != nil {
		return nil, fmt.Errorf("getReactionsBatch: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64][]ReactionInfo)
	for rows.Next() {
		var msgID int64
		var ri ReactionInfo
		var me int
		if scanErr := rows.Scan(&msgID, &ri.Emoji, &ri.Count, &me); scanErr != nil {
			return nil, fmt.Errorf("getReactionsBatch scan: %w", scanErr)
		}
		ri.Me = me != 0
		result[msgID] = append(result[msgID], ri)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("getReactionsBatch rows: %w", rows.Err())
	}
	return result, nil
}
