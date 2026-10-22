package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ReadPointerOp names which move MoveReadPointer makes.
type ReadPointerOp int

const (
	// ReadAtLatest moves the pointer to the channel's newest live message and
	// clears the badge, the same result as MarkChannelReadAtLatest. It never
	// moves the pointer backward.
	ReadAtLatest ReadPointerOp = iota + 1
	// ReadUpTo moves the pointer forward to a message id, clamped to the
	// channel's newest message. A pointer already past it is left alone.
	ReadUpTo
	// MarkUnread moves the pointer to the message just before a live message of
	// the channel. It may move either way.
	MarkUnread
)

// ReadPointer is the read state MoveReadPointer leaves behind, the payload of
// the read_state frame.
type ReadPointer struct {
	// LastReadMessageID is read_states.last_message_id after the move.
	LastReadMessageID int64
	// UnreadCount is the live messages after the pointer, capped at
	// ReadPointerUnreadCap like the count ready sends.
	UnreadCount int64
	// MentionCount is read_states.mention_count after the move.
	MentionCount int64
}

// ReadPointerUnreadCap bounds ReadPointer.UnreadCount, matching the cap on the
// unread count in the ready payload.
const ReadPointerUnreadCap = 100

// MoveReadPointer is the one place a reader's pointer moves to anything but
// "everything": it reads the mention receipts, updates read_states (pointer and
// a recomputed mention_count) and reads the unread count in a single writer
// transaction. The writer pool is one connection, so the move is atomic
// against every mention increment and decrement. The caller (MessageService)
// holds mentionEmitMu across the call and the frame it sends.
//
// Rules, with R(p) the live receipts after p from authors the user does not
// block:
//
//	ReadAtLatest: pointer MAX(old, newest live), count 0.
//	ReadUpTo:     pointer MAX(old, MIN(messageID, newest any)). If it moved,
//	              count MIN(old, R(new)), otherwise unchanged.
//	MarkUnread:   pointer = largest id below messageID (0 if none). Moving
//	              back count MAX(old, R(new)), forward MIN(old, R(new)), same
//	              unchanged. messageID must be a live message of the channel,
//	              otherwise ErrNotFound and nothing changes.
//
// A forward move never raises a badge and a backward move never lowers one.
// A mention increment still waiting for its flush finds last_message_id below
// its message, adds one and writes its receipt after this commit, so it is
// counted once: this recompute cannot see it, because its receipt does not
// exist yet.
func (d *DB) MoveReadPointer(ctx context.Context, userID, channelID int64, op ReadPointerOp, messageID int64) (ReadPointer, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return ReadPointer{}, fmt.Errorf("MoveReadPointer begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Every statement below is a QueryRow or Exec, so no rows cursor is ever
	// open while the next statement runs on the single writer connection.
	oldPtr, oldCount, found, err := readStateInTx(ctx, tx, userID, channelID)
	if err != nil {
		return ReadPointer{}, err
	}
	var maxAny, maxLive int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0), COALESCE(MAX(CASE WHEN deleted = 0 THEN id END), 0)
		   FROM messages WHERE channel_id = ?`, channelID,
	).Scan(&maxAny, &maxLive); err != nil {
		return ReadPointer{}, fmt.Errorf("MoveReadPointer channel bounds: %w", err)
	}

	newPtr, newCount, err := nextReadPointer(ctx, tx, userID, channelID, op, messageID, oldPtr, oldCount, maxAny, maxLive)
	if err != nil {
		return ReadPointer{}, err
	}

	// Skip a write that would store what is already there; a missing row is
	// always written so the pointer exists afterwards.
	if !found || newPtr != oldPtr || newCount != oldCount {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, channel_id) DO UPDATE SET
			     last_message_id = excluded.last_message_id,
			     mention_count = excluded.mention_count`,
			userID, channelID, newPtr, newCount); err != nil {
			return ReadPointer{}, fmt.Errorf("MoveReadPointer write: %w", err)
		}
	}

	var unread int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM (SELECT 1 FROM messages
		   WHERE channel_id = ? AND deleted = 0 AND id > ? LIMIT ?)`,
		channelID, newPtr, ReadPointerUnreadCap).Scan(&unread); err != nil {
		return ReadPointer{}, fmt.Errorf("MoveReadPointer unread count: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return ReadPointer{}, fmt.Errorf("MoveReadPointer commit: %w", err)
	}
	return ReadPointer{LastReadMessageID: newPtr, UnreadCount: unread, MentionCount: newCount}, nil
}

// readStateInTx reads the caller's row inside tx; found is false for none.
func readStateInTx(ctx context.Context, tx *sql.Tx, userID, channelID int64) (ptr, count int64, found bool, err error) {
	switch qErr := tx.QueryRowContext(ctx,
		`SELECT last_message_id, mention_count FROM read_states WHERE user_id = ? AND channel_id = ?`,
		userID, channelID).Scan(&ptr, &count); {
	case errors.Is(qErr, sql.ErrNoRows):
		return 0, 0, false, nil
	case qErr != nil:
		return 0, 0, false, fmt.Errorf("MoveReadPointer read state: %w", qErr)
	}
	return ptr, count, true, nil
}

// receiptsAfter is R(p): the live mention receipts after p that the user's
// current blocks do not exclude.
func receiptsAfter(ctx context.Context, tx *sql.Tx, userID, channelID, ptr int64) (int64, error) {
	var n int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM mention_receipts r
		   JOIN messages m ON m.id = r.message_id
		  WHERE r.user_id = ? AND r.channel_id = ? AND r.message_id > ?
		    AND m.deleted = 0
		    AND NOT EXISTS (SELECT 1 FROM user_blocks b
		                     WHERE b.blocker_id = r.user_id AND b.blocked_id = m.user_id)`,
		userID, channelID, ptr).Scan(&n); err != nil {
		return 0, fmt.Errorf("MoveReadPointer receipts: %w", err)
	}
	return n, nil
}

// nextReadPointer applies op's rules (see MoveReadPointer) to the stored
// pointer and count and returns the new pair. It reads inside tx and writes
// nothing.
func nextReadPointer(ctx context.Context, tx *sql.Tx, userID, channelID int64, op ReadPointerOp, messageID, oldPtr, oldCount, maxAny, maxLive int64) (newPtr, newCount int64, err error) {
	switch op {
	case ReadAtLatest:
		return max(oldPtr, maxLive), 0, nil
	case ReadUpTo:
		newPtr = max(oldPtr, min(messageID, maxAny))
		if newPtr == oldPtr {
			return newPtr, oldCount, nil
		}
		r, err := receiptsAfter(ctx, tx, userID, channelID, newPtr)
		if err != nil {
			return 0, 0, err
		}
		return newPtr, min(oldCount, r), nil
	case MarkUnread:
		var one int
		switch qErr := tx.QueryRowContext(ctx,
			`SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0`,
			messageID, channelID).Scan(&one); {
		case errors.Is(qErr, sql.ErrNoRows):
			return 0, 0, fmt.Errorf("MoveReadPointer message %d: %w", messageID, ErrNotFound)
		case qErr != nil:
			return 0, 0, fmt.Errorf("MoveReadPointer message lookup: %w", qErr)
		}
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND id < ?`,
			channelID, messageID).Scan(&newPtr); err != nil {
			return 0, 0, fmt.Errorf("MoveReadPointer previous message: %w", err)
		}
		if newPtr == oldPtr {
			return newPtr, oldCount, nil
		}
		r, err := receiptsAfter(ctx, tx, userID, channelID, newPtr)
		if err != nil {
			return 0, 0, err
		}
		if newPtr < oldPtr {
			return newPtr, max(oldCount, r), nil
		}
		return newPtr, min(oldCount, r), nil
	default:
		return 0, 0, fmt.Errorf("MoveReadPointer: unknown op %d", op)
	}
}
