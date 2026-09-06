package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// Message request states (migration 046's CHECK constraint). Only "pending"
// is a starting state; the other four are terminal.
const (
	msgReqPending  = "pending"
	msgReqAccepted = "accepted"
	msgReqIgnored  = "ignored"
	msgReqDeleted  = "deleted"
	msgReqBlocked  = "blocked"
)

// MessageRequestService is B5-6's first-contact gate and trusted-sender
// bookkeeping: staging a message_requests row instead of opening a DM for a
// one-to-one sender the recipient does not yet trust (decision 4), and the
// recipient-only transitions between its states. See
// docs/architecture/community-services.md section S1 for the abuse cases and
// data-ownership rules this backs, and docs/protocol.md's dm_request section
// for the frame it drives.
type MessageRequestService struct {
	st     Store
	blocks *BlockService
}

// NewMessageRequestService creates a MessageRequestService.
func NewMessageRequestService(st Store, blocks *BlockService) *MessageRequestService {
	return &MessageRequestService{st: st, blocks: blocks}
}

// ListPending returns userID's request inbox, newest first.
func (s *MessageRequestService) ListPending(ctx context.Context, userID int64) ([]db.MessageRequestView, error) {
	views, err := s.st.ListPendingMessageRequests(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list message requests", ErrInternal)
	}
	if views == nil {
		views = []db.MessageRequestView{}
	}
	return views, nil
}

// Accept transitions id to accepted: in one transaction, the recipient
// trusts the sender, the DM opens for the recipient, and the request is
// marked decided (db.DB.AcceptMessageRequest). Returns the updated request,
// ErrNotFound (the row is not this recipient's) or ErrConflict (it exists
// but was not pending — a race, including a concurrent accept).
func (s *MessageRequestService) Accept(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	req, err := s.st.AcceptMessageRequest(ctx, id, userID)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrNotFound):
			return nil, fmt.Errorf("%w: message request not found", ErrNotFound)
		case errors.Is(err, db.ErrConflict):
			return nil, fmt.Errorf("%w: message request is not pending", ErrConflict)
		default:
			return nil, fmt.Errorf("%w: failed to accept message request", ErrInternal)
		}
	}
	return req, nil
}

// Ignore transitions id to ignored: the request drops out of the recipient's
// inbox and nothing else changes.
func (s *MessageRequestService) Ignore(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	return s.transition(ctx, userID, id, msgReqIgnored)
}

// Delete transitions id to deleted. Server-side this is identical to Ignore
// — the held message rows stay in the channel, since the recipient never
// opened it — the distinction is purely what the recipient's client shows
// them (docs/protocol.md's dm_request section).
func (s *MessageRequestService) Delete(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	return s.transition(ctx, userID, id, msgReqDeleted)
}

// Block blocks the request's sender (BlockService.BlockUser, with its
// existing side effects) and only then transitions the request to blocked —
// in that order, so a failed block leaves the request's state unchanged.
//
// blockedSenderID is req.SenderID whenever BlockUser itself committed,
// regardless of what happens to the transition afterward — the caller
// (api/dm_request_handler.go, Codex P1-3) needs it to run the same voice
// eviction PUT /api/v1/blocks/{id} does even when the transition below
// loses a race and err is non-nil: the block already committed, and an
// already-blocked user must not keep a live voice session in the pair's DM
// just because the request's own state update failed.
func (s *MessageRequestService) Block(ctx context.Context, userID, id int64) (req *db.MessageRequest, blockedSenderID int64, err error) {
	current, err := s.st.GetMessageRequest(ctx, id, userID)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: message request not found", ErrNotFound)
	}
	if current.State != msgReqPending {
		return nil, 0, fmt.Errorf("%w: message request is not pending", ErrConflict)
	}
	if err := s.blocks.BlockUser(ctx, userID, current.SenderID); err != nil {
		return nil, 0, err
	}
	req, err = s.transition(ctx, userID, id, msgReqBlocked)
	return req, current.SenderID, err
}

// transition is the shared guarded-UPDATE path for Ignore/Delete/Block's
// final step: TransitionMessageRequest's WHERE clause matches only a pending
// row owned by userID, so a zero-rows result is ambiguous between "not
// yours" and "no longer pending" — raceOrNotFound tells them apart with one
// more read.
func (s *MessageRequestService) transition(ctx context.Context, userID, id int64, newState string) (*db.MessageRequest, error) {
	ok, err := s.st.TransitionMessageRequest(ctx, id, userID, newState)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to update message request", ErrInternal)
	}
	if !ok {
		return nil, s.raceOrNotFound(ctx, userID, id)
	}
	req, err := s.st.GetMessageRequest(ctx, id, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to reload message request", ErrInternal)
	}
	return req, nil
}

// raceOrNotFound distinguishes a losing race (409: the row exists for this
// recipient but is no longer pending — including the winner of a concurrent
// decision) from a request that was never this recipient's to decide (404).
func (s *MessageRequestService) raceOrNotFound(ctx context.Context, userID, id int64) error {
	if _, err := s.st.GetMessageRequest(ctx, id, userID); err != nil {
		return fmt.Errorf("%w: message request not found", ErrNotFound)
	}
	return fmt.Errorf("%w: message request is not pending", ErrConflict)
}

// firstContact stages first contact from senderID to recipientID in a
// one-to-one DM: creates a pending message_requests row if none exists yet
// for the pair in ANY state, and marks senderID as a trusted sender of
// recipientID (source "sent_first") — senderID initiated, so recipientID's
// eventual reply is a reply, not a first-contact request back. Both writes
// run in ONE transaction (db.DB.CreateMessageRequest, Codex P2-6): a
// request insert that committed with no trust write to follow would leave
// a pending row nothing could ever repair, since a resend just finds the
// row already there (decision 5's "one row per pair, ever" silence) and
// retries nothing.
//
// messageID is the send's own message — reused verbatim as
// first_message_id (Codex P1-4/P2-6), so the row this call creates and the
// dm_request frame the caller builds from its own result name the same
// message even under a concurrent race, and the REST inbox's preview can
// never drift from the live frame's.
//
// Returns the newly created row, or nil when a request already existed
// (resend while pending/ignored/deleted/blocked, or the loser of a race) —
// nil is not an error, it just means no new dm_request frame is owed.
func (s *MessageRequestService) firstContact(ctx context.Context, senderID, recipientID, channelID, messageID int64) (*db.MessageRequest, error) {
	created, err := s.st.CreateMessageRequest(ctx, senderID, recipientID, channelID, messageID)
	if err != nil {
		return nil, err
	}
	if !created {
		return nil, nil
	}
	req, err := s.st.GetMessageRequestByPair(ctx, senderID, recipientID)
	if err != nil {
		return nil, err
	}
	return req, nil
}

// DMDeliveryAudience returns who should receive a live frame that
// senderID's action in channelID just produced (a chat message, edit,
// delete, reaction, or typing indicator): senderID themselves, plus every
// other participant who trusts senderID for a one-to-one DM, or every
// participant for a group DM (B5-6 decision 6 — group DMs are untouched).
// An untrusted recipient of a pending/ignored/deleted/blocked request is
// never in the returned set; their only frame from this channel is
// dm_request.
func (s *MessageRequestService) DMDeliveryAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	participantIDs, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, err
	}
	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if isGroup {
		return participantIDs, nil
	}
	audience := make([]int64, 0, len(participantIDs))
	for _, pid := range participantIDs {
		if pid == senderID {
			audience = append(audience, pid)
			continue
		}
		trusted, tErr := s.st.IsTrustedSender(ctx, pid, senderID)
		if tErr != nil {
			return nil, tErr
		}
		if trusted {
			audience = append(audience, pid)
		}
	}
	return audience, nil
}
