package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// Message request states (migration 046's CHECK); only "pending" is a starting state.
const (
	msgReqPending  = "pending"
	msgReqAccepted = "accepted"
	msgReqIgnored  = "ignored"
	msgReqDeleted  = "deleted"
	msgReqBlocked  = "blocked"
)

// messageRequestStore is what MessageRequestService reads and writes. *db.DB satisfies it.
type messageRequestStore interface {
	GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []db.DMDeliveryTarget, err error)
	CreateMessageRequest(ctx context.Context, senderID, recipientID, channelID, firstMessageID int64) (db.MessageRequestOutcome, error)
	GetMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error)
	GetMessageRequestByPair(ctx context.Context, senderID, recipientID int64) (*db.MessageRequest, error)
	ListPendingMessageRequests(ctx context.Context, recipientID int64) ([]db.MessageRequestView, error)
	TransitionMessageRequest(ctx context.Context, id, recipientID int64, to string) (bool, error)
	AcceptMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error)
}

// MessageRequestService is the first-contact gate and trusted-sender bookkeeping. See
// docs/architecture/community-services.md section S1.
type MessageRequestService struct {
	st     messageRequestStore
	blocks *BlockService
}

// NewMessageRequestService creates a MessageRequestService.
func NewMessageRequestService(st messageRequestStore, blocks *BlockService) *MessageRequestService {
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

// Accept transitions id to accepted in one transaction: the recipient trusts the sender, the DM opens, the
// request is decided. Returns ErrNotFound (not this recipient's) or ErrConflict (not pending, including a
// concurrent accept).
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

// Delete transitions id to deleted; server-side identical to Ignore, only the client's display differs.
func (s *MessageRequestService) Delete(ctx context.Context, userID, id int64) (*db.MessageRequest, error) {
	return s.transition(ctx, userID, id, msgReqDeleted)
}

// Block blocks the sender (BlockService.BlockUser), then transitions the request, in that order so a failed
// block leaves the state unchanged. blockedSenderID is req.SenderID whenever BlockUser committed, even if the
// transition fails: the caller needs it for the voice eviction.
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

// transition is the guarded UPDATE for Ignore/Delete/Block: zero rows is ambiguous between "not yours" and
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

// raceOrNotFound separates a lost race (409) from a request never theirs to decide (404).
func (s *MessageRequestService) raceOrNotFound(ctx context.Context, userID, id int64) error {
	if _, err := s.st.GetMessageRequest(ctx, id, userID); err != nil {
		return fmt.Errorf("%w: message request not found", ErrNotFound)
	}
	return fmt.Errorf("%w: message request is not pending", ErrConflict)
}

// firstContact stages first contact in a one-to-one DM: a pending message_requests row if none exists for the
// pair in ANY state, and marks senderID a trusted sender of recipientID (source "sent_first"). Both writes
// share ONE transaction: a request without its trust write would leave a pending row nothing could repair.
// messageID is reused as first_message_id. Returns nil when a request already existed; with message requests
// off the outcome is AutoAccepted and the row nil (no frame).
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

// DMDeliveryAudience returns who receives a live frame for senderID's action in channelID: senderID plus
// every participant who trusts senderID (one-to-one) or every participant (group). An untrusted recipient is
// never included; their only frame is dm_request.
func (s *MessageRequestService) DMDeliveryAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	isGroup, targets, err := s.st.GetDMDeliveryTargets(ctx, channelID, senderID)
	if err != nil {
		return nil, err
	}
	return dmDeliveryAudience(isGroup, targets, senderID), nil
}

// dmDeliveryAudience is the rule over targets already read, shared with SendMessage.
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

func dmTargetIDs(targets []db.DMDeliveryTarget) []int64 {
	ids := make([]int64, 0, len(targets))
	for _, t := range targets {
		ids = append(ids, t.UserID)
	}
	return ids
}
