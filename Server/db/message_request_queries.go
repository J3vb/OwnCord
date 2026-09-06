package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// MessageRequest is one row of message_requests (migration 046, B5-6): a
// staged first contact between a stranger sender and a recipient who does
// not yet trust them. See the migration's own comment for the full shape.
type MessageRequest struct {
	ID          int64
	SenderID    int64
	RecipientID int64
	ChannelID   int64
	// FirstMessageID is the message this request was created for, set once
	// at creation (Codex P1-4/P2-6 — see the migration's own deviation
	// note). nil for a grandfathered installation's pre-existing rows,
	// which cannot happen today since nothing grandfathers message_requests
	// itself, only trusted_senders.
	FirstMessageID *int64
	State          string
	CreatedAt      string
	DecidedAt      *string
}

// MessageRequestView is one pending request the way GET /api/v1/dm-requests
// lists it: joined to the sender's profile and a preview of the channel's
// first message (the one the request was created for — a resend while the
// request is pending/ignored/deleted creates no second row, so the preview
// always names the original message).
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

// IsTrustedSender reports whether recipientID has a standing trust row for
// senderID. The row's source (accepted / sent_first / grandfathered) does
// not change what trust means to the gate — any row at all is trust.
func (d *DB) IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error) {
	n, err := d.q.IsTrustedSender(ctx, dbgen.IsTrustedSenderParams{RecipientID: recipientID, SenderID: senderID})
	if err != nil {
		return false, fmt.Errorf("IsTrustedSender: %w", err)
	}
	return n > 0, nil
}

// TrustSender writes a trust row. INSERT OR IGNORE: a pair that already
// trusts each other keeps its original source rather than being overwritten
// by a later call with a different one (e.g. a resend re-affirming
// "sent_first" after acceptance already recorded "accepted" would be wrong).
func (d *DB) TrustSender(ctx context.Context, recipientID, senderID int64, source string) error {
	if err := d.q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: senderID, Source: source}); err != nil {
		return fmt.Errorf("TrustSender: %w", err)
	}
	return nil
}

// CreateMessageRequest stages a pending request for (senderID, recipientID)
// in channelID, naming firstMessageID as the held message, and — in the SAME
// transaction — marks senderID as a trusted sender of recipientID (source
// "sent_first"): senderID initiated, so recipientID's eventual reply is a
// reply, not a first-contact request back. Codex P2-6: the two writes used
// to be separate calls, so a request insert that committed followed by a
// failed trust write left a pending row with no reverse trust and no way to
// repair it — a resend finds the row already there (INSERT OR IGNORE) and
// stays silent forever (decision 5), so nothing ever retries the trust
// write either.
//
// The request insert is INSERT OR IGNORE against the UNIQUE(sender_id,
// recipient_id) constraint: one row per pair EVER, so a request already
// existing in ANY state — pending, ignored, deleted, blocked, even
// accepted, though an accepted pair is trusted and should never reach here
// — leaves created false and changes nothing. That is what makes a resend
// after "ignored" silent (decision 5): there is only ever one row to have
// created. The trust write itself is unconditional (also INSERT OR IGNORE)
// regardless of created: a repeat send while the request is still pending
// (or already ignored/deleted) just re-affirms a trust row that may already
// be there, and skipping it on a race would leave the loser of two
// concurrent first messages without it. Under two concurrent first sends
// only one request INSERT wins, so first_message_id always names the
// winner's own message — the same one its dm_request frame carries as a
// preview (Codex P2-6).
func (d *DB) CreateMessageRequest(ctx context.Context, senderID, recipientID, channelID, firstMessageID int64) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("CreateMessageRequest begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	q := d.q.WithTx(tx)

	n, err := q.InsertMessageRequest(ctx, dbgen.InsertMessageRequestParams{
		SenderID: senderID, RecipientID: recipientID, ChannelID: channelID, FirstMessageID: &firstMessageID,
	})
	if err != nil {
		return false, fmt.Errorf("CreateMessageRequest insert: %w", err)
	}
	if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: senderID, SenderID: recipientID, Source: "sent_first"}); err != nil {
		return false, fmt.Errorf("CreateMessageRequest trust: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("CreateMessageRequest commit: %w", err)
	}
	committed = true
	return n > 0, nil
}

// SetAcceptMessageRequestGuardHookForTest installs (or, with a nil hook,
// clears) the acceptGuardHook test seam described on DB.acceptGuardHook
// (Codex P2-8). Exported for cross-package tests (service), following the
// existing *ForTest convention (ws.HandleMessageForTest,
// MessageService.RunBackgroundInlineForTest) rather than an export_test.go,
// which only reaches tests of this same package.
func (d *DB) SetAcceptMessageRequestGuardHookForTest(hook func()) {
	d.acceptGuardHook = hook
}

// GetMessageRequest reads request id, scoped to recipientID so one user can
// never read another's inbox row by guessing an id. ErrNotFound when no such
// row exists for this recipient.
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

// GetMessageRequestByPair reads the (at most one, UNIQUE-enforced) request
// for a (senderID, recipientID) pair. ErrNotFound when none exists.
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

// ListPendingMessageRequests lists recipientID's inbox, newest first: every
// pending request joined to the sender's profile and a preview of the
// channel's first message.
func (d *DB) ListPendingMessageRequests(ctx context.Context, recipientID int64) ([]MessageRequestView, error) {
	rows, err := d.q.ListPendingMessageRequests(ctx, recipientID)
	if err != nil {
		return nil, fmt.Errorf("ListPendingMessageRequests: %w", err)
	}
	out := make([]MessageRequestView, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		out = append(out, MessageRequestView{
			MessageRequest: MessageRequest{
				ID: r.ID, SenderID: r.SenderID, RecipientID: r.RecipientID,
				ChannelID: r.ChannelID, State: r.State, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
			},
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
// recipientID. Reports whether the guarded UPDATE matched a row; false means
// either the row does not belong to this recipient or it was not pending —
// the caller (service.MessageRequestService) tells the two apart with a
// GetMessageRequest read (404 vs. 409).
func (d *DB) TransitionMessageRequest(ctx context.Context, id, recipientID int64, to string) (bool, error) {
	n, err := d.q.TransitionMessageRequest(ctx, dbgen.TransitionMessageRequestParams{
		State: to, ID: id, RecipientID: recipientID,
	})
	if err != nil {
		return false, fmt.Errorf("TransitionMessageRequest: %w", err)
	}
	return n > 0, nil
}

// AcceptMessageRequest is Accept's single transaction: load+guard (must be
// pending, scoped to recipientID), TrustSender(recipient, sender,
// "accepted"), OpenDM(recipient, channel), then the state transition — all
// or nothing, mirroring UpsertPushSubscription's writer-tx shape
// (db/push_subscription_queries.go). Returns ErrNotFound when the row is not
// this recipient's and ErrConflict when it exists but is no longer pending
// (a race with another transition, including a concurrent Accept).
func (d *DB) AcceptMessageRequest(ctx context.Context, id, recipientID int64) (*MessageRequest, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
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
		// Cannot happen on the single writer connection this transaction runs
		// on (nothing else can have changed row's state between the read
		// above and here) — kept as a defensive guard, not an assumption.
		return nil, ErrConflict
	}

	updated, err := q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{ID: id, RecipientID: recipientID})
	if err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest reread: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("AcceptMessageRequest commit: %w", err)
	}
	committed = true
	return fromDBGenMessageRequest(updated), nil
}
