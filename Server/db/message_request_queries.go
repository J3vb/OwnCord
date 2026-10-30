package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// MessageRequest is one row of message_requests: a staged first contact
// between a stranger sender and a recipient who does not yet trust them.
type MessageRequest struct {
	ID          int64
	SenderID    int64
	RecipientID int64
	ChannelID   int64
	// FirstMessageID is the message this request was created for, set once at
	// creation; nil for rows that predate it.
	FirstMessageID *int64
	State          string
	CreatedAt      string
	DecidedAt      *string
}

// MessageRequestView is one pending request as GET /api/v1/dm-requests lists
// it: joined to the sender's profile and a preview of the channel's first
// message. A resend creates no second row, so the preview names the original.
type MessageRequestView struct {
	MessageRequest
	SenderUsername    string
	SenderDisplayName string
	SenderAvatar      string
	PreviewMessageID  int64
	PreviewContent    string
	PreviewTimestamp  string
}

func fromDBGenMessageRequest(r dbgen.MessageRequest) *MessageRequest {
	return &MessageRequest{
		ID:             r.ID,
		SenderID:       r.SenderID,
		RecipientID:    r.RecipientID,
		ChannelID:      r.ChannelID,
		FirstMessageID: r.FirstMessageID,
		State:          r.State,
		CreatedAt:      r.CreatedAt,
		DecidedAt:      r.DecidedAt,
	}
}

// IsTrustedSender reports whether recipientID has a trust row for senderID;
// the row's source does not matter, any row is trust.
func (d *DB) IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error) {
	n, err := d.q.IsTrustedSender(ctx, dbgen.IsTrustedSenderParams{RecipientID: recipientID, SenderID: senderID})
	if err != nil {
		return false, fmt.Errorf("IsTrustedSender: %w", err)
	}
	return n > 0, nil
}

// TrustSender writes a trust row with INSERT OR IGNORE, so a pair that already
// trusts keeps its original source (a resend's "sent_first" must not overwrite
// "accepted").
func (d *DB) TrustSender(ctx context.Context, recipientID, senderID int64, source string) error {
	if err := d.q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: senderID, Source: source}); err != nil {
		return fmt.Errorf("TrustSender: %w", err)
	}
	return nil
}

// MessageRequestOutcome is what CreateMessageRequest decided for one first send.
type MessageRequestOutcome struct {
	// Created is true when this call inserted the pair's request row.
	Created bool
	// AutoAccepted is true when the recipient has message requests off (and direct
	// messages on) and trusts the sender after this call: the message is
	// delivered, not staged.
	AutoAccepted bool
	// Opened is true when this call opened the DM for the recipient.
	Opened bool
}

// CreateMessageRequest stages first contact for (senderID, recipientID) in
// channelID, naming firstMessageID as the held message, and in the same
// transaction marks senderID a trusted sender of recipientID (source
// "sent_first"), since senderID initiated and the reply is not a first-contact
// request back. Separate writes could commit the request and fail the trust
// write, and a resend finds the row (INSERT OR IGNORE) and never retries it.
//
// The request insert is INSERT OR IGNORE on UNIQUE(sender_id, recipient_id):
// one row per pair ever, so a request in any state leaves Created false and
// changes nothing, which keeps a resend after "ignored" silent. The trust write
// is unconditional regardless of Created: skipping it on a race would leave the
// loser of two concurrent first messages without it. Only one request INSERT
// wins, so first_message_id names the winner's message, the preview its
// dm_request frame carries.
//
// The transaction reads recipientID's user_privacy itself, so a settings
// change racing the send is decided by this read. With direct messages allowed
// and message requests off, the row is born "accepted" (decided_at set),
// recipientID trusts senderID and the DM opens for them, all in this
// transaction; AutoAccepted is then true and the message is delivered. Any
// other setting stages as above. A caller that finds the pair's row already
// there reports AutoAccepted whenever recipientID trusts senderID (trust, not
// request state or current setting, decides delivery), so a racing loser is
// delivered too; Opened is true for exactly one of them. A block between the
// pair always stages.
func (d *DB) CreateMessageRequest(ctx context.Context, senderID, recipientID, channelID, firstMessageID int64) (MessageRequestOutcome, error) {
	var out MessageRequestOutcome
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return out, fmt.Errorf("CreateMessageRequest begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	priv := DefaultUserPrivacy()
	row, err := q.GetUserPrivacy(ctx, recipientID)
	switch {
	case err == nil:
		priv = UserPrivacy{AllowMemberDMs: row.AllowMemberDms != 0, MessageRequests: row.MessageRequests != 0}
	case errors.Is(err, sql.ErrNoRows):
		// No saved settings: both on, so requests are staged.
	default:
		return out, fmt.Errorf("CreateMessageRequest privacy: %w", err)
	}
	// A block between the pair, read in this transaction, always stages, so a
	// recipient who blocks the sender mid-send never ends up trusting them.
	blocked := true
	if _, err := q.IsEitherBlocked(ctx, dbgen.IsEitherBlockedParams{
		BlockerID: senderID, BlockedID: recipientID, BlockerID_2: recipientID, BlockedID_2: senderID,
	}); errors.Is(err, sql.ErrNoRows) {
		blocked = false
	} else if err != nil {
		return out, fmt.Errorf("CreateMessageRequest blocks: %w", err)
	}
	autoAccept := priv.AllowMemberDMs && !priv.MessageRequests && !blocked

	var n int64
	if autoAccept {
		n, err = q.InsertAcceptedMessageRequest(ctx, dbgen.InsertAcceptedMessageRequestParams{
			SenderID: senderID, RecipientID: recipientID, ChannelID: channelID, FirstMessageID: &firstMessageID,
		})
	} else {
		n, err = q.InsertMessageRequest(ctx, dbgen.InsertMessageRequestParams{
			SenderID: senderID, RecipientID: recipientID, ChannelID: channelID, FirstMessageID: &firstMessageID,
		})
	}
	if err != nil {
		return out, fmt.Errorf("CreateMessageRequest insert: %w", err)
	}
	out.Created = n > 0
	if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: senderID, SenderID: recipientID, Source: "sent_first"}); err != nil {
		return out, fmt.Errorf("CreateMessageRequest trust: %w", err)
	}
	if autoAccept || (!out.Created && !blocked) {
		if err := acceptFirstContact(ctx, q, senderID, recipientID, channelID, &out); err != nil {
			return out, err
		}
	}

	if err := tx.Commit(); err != nil {
		return MessageRequestOutcome{}, fmt.Errorf("CreateMessageRequest commit: %w", err)
	}
	return out, nil
}

// GetMessageRequest reads request id scoped to recipientID, so a guessed id
// never reads another's inbox row. ErrNotFound when none exists for them.
func (d *DB) GetMessageRequest(ctx context.Context, id, recipientID int64) (*MessageRequest, error) {
	row, err := d.q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{
		ID: id, RecipientID: recipientID,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetMessageRequest: %w", err)
	}
	return fromDBGenMessageRequest(row), nil
}

// GetMessageRequestByPair reads the (UNIQUE, so at most one) request for a
// pair, or ErrNotFound.
func (d *DB) GetMessageRequestByPair(ctx context.Context, senderID, recipientID int64) (*MessageRequest, error) {
	row, err := d.q.GetMessageRequestByPair(ctx, dbgen.GetMessageRequestByPairParams{
		SenderID: senderID, RecipientID: recipientID,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetMessageRequestByPair: %w", err)
	}
	return fromDBGenMessageRequest(row), nil
}

// ListPendingMessageRequests lists recipientID's inbox, newest first: pending
// requests joined to the sender's profile and a first-message preview.
func (d *DB) ListPendingMessageRequests(ctx context.Context, recipientID int64) ([]MessageRequestView, error) {
	rows, err := d.q.ListPendingMessageRequests(ctx, recipientID)
	if err != nil {
		return nil, fmt.Errorf("ListPendingMessageRequests: %w", err)
	}
	out := make([]MessageRequestView, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		out = append(out, MessageRequestView{
			ID: r.ID, SenderID: r.SenderID, RecipientID: r.RecipientID,
			ChannelID: r.ChannelID, State: r.State, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
			SenderUsername:    r.SenderUsername,
			SenderDisplayName: r.SenderDisplayName,
			SenderAvatar:      r.SenderAvatar,
			PreviewMessageID:  r.PreviewMessageID,
			PreviewContent:    r.PreviewContent,
			PreviewTimestamp:  r.PreviewTimestamp,
		})
	}
	return out, nil
}

// TransitionMessageRequest moves id from pending to `to`, scoped to
// recipientID. False means the row is not this recipient's or was not pending;
// service.MessageRequestService tells them apart with GetMessageRequest (404
// vs 409).
func (d *DB) TransitionMessageRequest(ctx context.Context, id, recipientID int64, to string) (bool, error) {
	n, err := d.q.TransitionMessageRequest(ctx, dbgen.TransitionMessageRequestParams{
		State: to, ID: id, RecipientID: recipientID,
	})
	if err != nil {
		return false, fmt.Errorf("TransitionMessageRequest: %w", err)
	}
	return n > 0, nil
}

// AcceptMessageRequest is Accept's single transaction: load and guard (pending,
// scoped to recipientID), TrustSender(recipient, sender, "accepted"),
// OpenDM(recipient, channel), then the state transition, all or nothing. It
// returns ErrNotFound when the row is not this recipient's and ErrConflict
// when it is no longer pending (including a concurrent Accept).
func (d *DB) AcceptMessageRequest(ctx context.Context, id, recipientID int64) (*MessageRequest, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	row, err := q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{ID: id, RecipientID: recipientID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("AcceptMessageRequest get: %w", err)
	}
	if row.State != "pending" {
		return nil, ErrConflict
	}
	if hook := d.acceptGuardHook; hook != nil {
		hook()
	}

	if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: row.SenderID, Source: "accepted"}); err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest trust: %w", err)
	}
	if _, err := q.OpenDM(ctx, dbgen.OpenDMParams{UserID: recipientID, ChannelID: row.ChannelID}); err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest opendm: %w", err)
	}
	n, err := q.TransitionMessageRequest(ctx, dbgen.TransitionMessageRequestParams{State: "accepted", ID: id, RecipientID: recipientID})
	if err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest transition: %w", err)
	}
	if n == 0 {
		// Cannot happen on the single writer connection (nothing can change row's
		// state since the read above); kept as a defensive guard.
		return nil, ErrConflict
	}

	updated, err := q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{ID: id, RecipientID: recipientID})
	if err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest reread: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest commit: %w", err)
	}
	return fromDBGenMessageRequest(updated), nil
}

// acceptFirstContact finishes a first send that may be delivered, inside
// CreateMessageRequest's transaction. The caller that inserted an accepted row
// writes the recipient's trust edge first. The recipient's trust of the
// sender, not the request's state or the current setting, decides delivery; a
// caller that found the row already there is delivered when trusted, then
// (re)opens the DM with INSERT OR IGNORE, so a recipient who closed it
// meanwhile gets dm_channel_open and exactly one caller reports Opened.
func acceptFirstContact(ctx context.Context, q *dbgen.Queries, senderID, recipientID, channelID int64, out *MessageRequestOutcome) error {
	if out.Created {
		if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: senderID, Source: "accepted"}); err != nil {
			return fmt.Errorf("CreateMessageRequest accept trust: %w", err)
		}
	}
	trusted, err := q.IsTrustedSender(ctx, dbgen.IsTrustedSenderParams{RecipientID: recipientID, SenderID: senderID})
	if err != nil {
		return fmt.Errorf("CreateMessageRequest trusted: %w", err)
	}
	if trusted == 0 {
		return nil
	}
	inserted, err := q.OpenDM(ctx, dbgen.OpenDMParams{UserID: recipientID, ChannelID: channelID})
	if err != nil {
		return fmt.Errorf("CreateMessageRequest opendm: %w", err)
	}
	out.Opened = inserted > 0
	out.AutoAccepted = true
	return nil
}
