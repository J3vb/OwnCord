package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// Message request states (migration 046's CHECK); only "pending" is a starting
// state, the other four are terminal.
const (
	msgReqPending  = "pending"
	msgReqAccepted = "accepted"
	msgReqIgnored  = "ignored"
	msgReqDeleted  = "deleted"
	msgReqBlocked  = "blocked"
)

// MessageRequestService is the first-contact gate and trusted-sender bookkeeping:
// it stages a message_requests row instead of opening a DM for a one-to-one
// sender the recipient does not yet trust, and runs the recipient-only
// transitions. See docs/architecture/community-services.md section S1.
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
		return nil, fmt.Errorf("%w: failed to list message requests: %w", ErrInternal, err)
	}
	if views == nil {
		views = []db.MessageRequestView{}
	}
	return views, nil
}

// Accept transitions id to accepted in one transaction: the recipient trusts the
// sender, the DM opens, and the request is marked decided. Returns ErrNotFound
// (not this recipient's) or ErrConflict (not pending, including a concurrent
// accept).
func (s *MessageRequestService) Accept(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	req, err := s.st.AcceptMessageRequest(ctx, id, userID)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrNotFound):
			return nil, fmt.Errorf("%w: message request not found", ErrNotFound)
		case errors.Is(err, db.ErrConflict):
			return nil, fmt.Errorf("%w: message request is not pending", ErrConflict)
		default:
			return nil, fmt.Errorf("%w: failed to accept message request: %w", ErrInternal, err)
		}
	}
	return req, nil
}

// Ignore transitions id to ignored: it drops out of the recipient's inbox and
// nothing else changes.
func (s *MessageRequestService) Ignore(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	return s.transition(ctx, userID, id, msgReqIgnored)
}

// Delete transitions id to deleted. Server-side identical to Ignore (the held
// message rows stay); only what the recipient's client shows differs.
func (s *MessageRequestService) Delete(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	return s.transition(ctx, userID, id, msgReqDeleted)
}

// Block blocks the request's sender (BlockService.BlockUser), then transitions
// the request to blocked, in that order so a failed block leaves the state
// unchanged.
// blockedSenderID is req.SenderID whenever BlockUser committed, even if the
// transition then fails: the caller needs it to run the same voice eviction as
// PUT /api/v1/blocks/{id}, since the block is already in force.
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

// transition is the guarded UPDATE for Ignore/Delete/Block: it matches only a
// pending row owned by userID, so zero rows is ambiguous between "not yours" and
// "no longer pending"; raceOrNotFound tells them apart.
func (s *MessageRequestService) transition(ctx context.Context, userID, id int64, newState string) (*db.MessageRequest, error) {
	ok, err := s.st.TransitionMessageRequest(ctx, id, userID, newState)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to update message request: %w", ErrInternal, err)
	}
	if !ok {
		return nil, s.raceOrNotFound(ctx, userID, id)
	}
	req, err := s.st.GetMessageRequest(ctx, id, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to reload message request: %w", ErrInternal, err)
	}
	return req, nil
}

// raceOrNotFound separates a lost race (409: the row exists for this recipient
// but is no longer pending) from a request never theirs to decide (404).
func (s *MessageRequestService) raceOrNotFound(ctx context.Context, userID, id int64) error {
	if _, err := s.st.GetMessageRequest(ctx, id, userID); err != nil {
		return fmt.Errorf("%w: message request not found", ErrNotFound)
	}
	return fmt.Errorf("%w: message request is not pending", ErrConflict)
}

// firstContact stages first contact from senderID to recipientID in a one-to-one
// DM: it creates a pending message_requests row if none exists for the pair in ANY
// state, and marks senderID a trusted sender of recipientID (source "sent_first"),
// so the recipient's reply is a reply, not a request back. Both writes share ONE
// transaction: a request that committed without its trust write would leave a
// pending row nothing could repair, since a resend finds the row and retries
// nothing.
// messageID is the send's own message, reused as first_message_id so the row and
// the caller's dm_request frame name the same message even under a race.
// Returns the new row, or nil when a request already existed (no frame owed, not
// an error). With message requests off the outcome reports AutoAccepted and the
// row is nil: the caller delivers and sends no frame.
func (s *MessageRequestService) firstContact(ctx context.Context, senderID, recipientID, channelID, messageID int64) (*db.MessageRequest, db.MessageRequestOutcome, error) {
	out, err := s.st.CreateMessageRequest(ctx, senderID, recipientID, channelID, messageID)
	if err != nil {
		return nil, db.MessageRequestOutcome{}, err
	}
	if !out.Created || out.AutoAccepted {
		return nil, out, nil
	}
	req, err := s.st.GetMessageRequestByPair(ctx, senderID, recipientID)
	if err != nil {
		return nil, out, err
	}
	return req, out, nil
}

// DMDeliveryAudience returns who receives a live frame that senderID's action in
// channelID produced (message, edit, delete, reaction, typing): senderID, plus
// every other participant who trusts senderID for a one-to-one DM, or every
// participant for a group DM. An untrusted recipient of a pending, ignored,
// deleted or blocked request is never included; their only frame is dm_request.
func (s *MessageRequestService) DMDeliveryAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	isGroup, targets, err := s.st.GetDMDeliveryTargets(ctx, channelID, senderID)
	if err != nil {
		return nil, err
	}
	return dmDeliveryAudience(isGroup, targets, senderID), nil
}

// dmDeliveryAudience is DMDeliveryAudience's rule over targets already read,
// shared with SendMessage to avoid a second read.
func dmDeliveryAudience(isGroup bool, targets []db.DMDeliveryTarget, senderID int64) []int64 {
	if isGroup {
		return dmTargetIDs(targets)
	}
	audience := make([]int64, 0, len(targets))
	for _, t := range targets {
		if t.UserID == senderID || t.TrustsSender {
			audience = append(audience, t.UserID)
		}
	}
	return audience
}

// dmTargetIDs is every participant's id, in read order.
func dmTargetIDs(targets []db.DMDeliveryTarget) []int64 {
	ids := make([]int64, 0, len(targets))
	for _, t := range targets {
		ids = append(ids, t.UserID)
	}
	return ids
}
