package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// GetOrCreateDMChannel finds or creates a DM between two users, opening it for both,
// and reports whether it was created. For callers with no first-contact gate
// (cmd/seed); service/dm.go uses GetOrCreateDMChannelGated.
func (d *DB) GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*Channel, bool, error) {
	ch, created, _, _, err := d.getOrCreateDMChannel(ctx, user1ID, user2ID, false)
	return ch, created, err
}

// GetOrCreateDMChannelGated is the gated variant for a caller-initiated 1:1 DM:
// on the create branch it decides whether to open the recipient's side (does
// the recipient already trust callerID?) and writes dm_open_state in the same
// transaction as the trust check. A separate CloseDM afterwards could leave the
// recipient open on a cancellation or close a DM they meanwhile accepted.
// recipientOpened is meaningful only when created is true.
func (d *DB) GetOrCreateDMChannelGated(ctx context.Context, callerID, recipientID int64) (ch *Channel, created bool, recipientOpened bool, accepted *MessageRequest, err error) {
	return d.getOrCreateDMChannel(ctx, callerID, recipientID, true)
}

// getOrCreateDMChannel is the shared implementation: user1ID is the caller, whose side
// ends up open; gateRecipient makes user2ID's side depend on trust. Lookup and create
// share one SERIALIZABLE transaction so racing requests cannot create two channels.
func (d *DB) getOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64, gateRecipient bool) (*Channel, bool, bool, *MessageRequest, error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel begin tx: %w", err)
	}

	// Look for an existing DM inside the transaction. The is_group clause keeps
	// group DMs out, or "message Bob" could land in a group containing both users;
	// it is the stored flag, not a participant count, because a group people left
	// can have two members and must still not answer "the DM between these two".
	var existingID int64
	err = tx.QueryRow(
		`SELECT dp1.channel_id FROM dm_participants dp1
		 JOIN dm_participants dp2 ON dp1.channel_id = dp2.channel_id
		 JOIN channels c ON c.id = dp1.channel_id
		 WHERE dp1.user_id = ? AND dp2.user_id = ? AND c.type = 'dm' AND c.is_group = 0
		 LIMIT 1`,
		user1ID, user2ID,
	).Scan(&existingID)

	if err == nil {
		// Existing channel: ensure the caller has it open (idempotent) so a user who
		// closed the DM sees it again when the other party re-initiates. The
		// recipient's side is untouched.
		_, _ = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, existingID,
		)
		// A recipient opening the DM while the other user's request is undecided is an
		// acceptance: same trust, open state and transition as AcceptMessageRequest.
		var accepted *MessageRequest
		if gateRecipient {
			var acceptErr error
			if accepted, acceptErr = acceptUndecidedRequestOnOpen(ctx, d.q.WithTx(tx), user1ID, user2ID); acceptErr != nil {
				_ = tx.Rollback()
				return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel accept request: %w", acceptErr)
			}
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel commit existing: %w", commitErr)
		}
		ch, getErr := d.GetChannel(ctx, existingID)
		if getErr != nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel fetch existing: %w", getErr)
		}
		if ch == nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel: channel %d vanished", existingID)
		}
		return ch, false, true, accepted, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel lookup: %w", err)
	}

	res, err := tx.Exec(
		`INSERT INTO channels (name, type) VALUES ('', 'dm')`,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel last insert id: %w", err)
	}

	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, user1ID, channelID, user2ID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel insert participants: %w", err)
	}

	if hook := d.afterDMParticipantsInsertHook; hook != nil {
		if hookErr := hook(); hookErr != nil {
			_ = tx.Rollback()
			return nil, false, false, nil, hookErr
		}
	}

	recipientOpened, err := decideAndOpenRecipientDM(tx, user1ID, user2ID, channelID, gateRecipient)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel fetch new: %w", err)
	}
	return ch, true, recipientOpened, nil, nil
}

// acceptUndecidedRequestOnOpen accepts the pending, ignored or deleted request
// senderID holds against recipientID (the opener); nil when none. q is bound to the
// caller's transaction.
func acceptUndecidedRequestOnOpen(ctx context.Context, q *dbgen.Queries, recipientID, senderID int64) (*MessageRequest, error) {
	row, err := q.GetMessageRequestByPair(ctx, dbgen.GetMessageRequestByPairParams{SenderID: senderID, RecipientID: recipientID})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get request: %w", err)
	}
	// Deleted is server-side identical to ignored: opening the conversation is the
	// decision. Accepted and blocked rows stay.
	switch row.State {
	case "pending", "ignored", "deleted":
	default:
		return nil, nil
	}
	if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: senderID, Source: "accepted"}); err != nil {
		return nil, fmt.Errorf("trust: %w", err)
	}
	if _, err := q.AcceptUndecidedMessageRequest(ctx, dbgen.AcceptUndecidedMessageRequestParams{ID: row.ID, RecipientID: recipientID}); err != nil {
		return nil, fmt.Errorf("transition: %w", err)
	}
	updated, err := q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{ID: row.ID, RecipientID: recipientID})
	if err != nil {
		return nil, fmt.Errorf("reread: %w", err)
	}
	return fromDBGenMessageRequest(updated), nil
}

// decideAndOpenRecipientDM decides (when gateRecipient) whether user2ID already
// trusts user1ID and writes dm_open_state against tx, so it commits or rolls back with the caller.
func decideAndOpenRecipientDM(tx *sql.Tx, user1ID, user2ID, channelID int64, gateRecipient bool) (recipientOpened bool, err error) {
	recipientOpened = true
	if gateRecipient {
		var trustCount int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`,
			user2ID, user1ID,
		).Scan(&trustCount); err != nil {
			return false, fmt.Errorf("trust check: %w", err)
		}
		recipientOpened = trustCount > 0
	}

	if recipientOpened {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?), (?, ?)`,
			user1ID, channelID, user2ID, channelID,
		)
	} else {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, channelID,
		)
	}
	if err != nil {
		return recipientOpened, fmt.Errorf("open dm: %w", err)
	}
	return recipientOpened, nil
}
