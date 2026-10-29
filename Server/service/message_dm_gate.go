package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// dmFirstContactGate runs the gate for one non-sender participant
// (recipient, read with its trust of the sender by GetDMDeliveryTargets) of
// a one-to-one DM p.UserID just sent into. It reports true when the send
// effect for this recipient is already fully handled (a request was staged,
// or the recipient is not reachable and gets nothing) — the caller's cue to skip
// OpenDM entirely for them. False means the recipient already trusts the
// sender and today's OpenDM path applies. A recipient with message requests
// off is accepted and opened inside the gate's own transaction; the gate
// then marks target as trusting the sender and reports true.
func (s *MessageService) dmFirstContactGate(ctx context.Context, p SendMessageParams, target *db.DMDeliveryTarget, result *SendMessageResult) bool {
	recipientID := target.UserID
	recipient, rErr := s.st.GetUserByID(ctx, recipientID)
	if rErr != nil {
		slog.Error("MessageService.SendMessage: recipient lookup for the first-contact gate failed",
			"err", rErr, "recipient_id", recipientID)
		return true // nothing more can be decided for them; do not OpenDM
	}
	// "Cannot receive DMs" (community-services.md S1): a recipient that is not
	// dmReachableUser gets no request row and no frame. The send itself still
	// succeeds for the sender.
	if !dmReachableUser(recipient) {
		return true
	}
	if target.TrustsSender {
		return false // today's OpenDM path
	}
	if hook := s.afterFirstContactTrustCheck; hook != nil {
		hook()
	}

	req, outcome, fcErr := s.messageRequests.firstContact(ctx, p.UserID, recipientID, p.ChannelID, result.MessageID)
	if fcErr != nil {
		slog.Error("MessageService.SendMessage: first-contact gate failed",
			"err", fcErr, "recipient_id", recipientID, "sender_id", p.UserID)
		return true
	}
	if outcome.AutoAccepted {
		// The recipient has message requests off: the transaction accepted
		// the pair and opened the DM, so this recipient is now a trusting
		// participant. Mark the in-memory target so the delivery audience,
		// mentions and push include them, announce the open once, and send
		// no dm_request frame.
		target.TrustsSender = true
		if outcome.Opened {
			result.OpenedDMFor = append(result.OpenedDMFor, recipientID)
		}
		return true
	}
	if req != nil {
		result.RequestCreatedFor = append(result.RequestCreatedFor, req)
		if result.RequestPreview == nil {
			if hook := s.beforeRequestPreviewLookup; hook != nil {
				hook(result.MessageID)
			}
			result.RequestPreview = s.canonicalRequestPreview(ctx, result.MessageID)
		}
	}
	return true
}

// canonicalRequestPreview reads messageID fresh rather than trusting the
// send's own cached content: the WS dm_request
// frame's preview must never disagree with the REST inbox's
// (db.DB.ListPendingMessageRequests joins first_message_id with
// deleted = 0) — building it from cached content let a delete racing the
// frame leave a stale, since-deleted preview on the wire while REST already
// reported preview: null for the very same request. nil (no preview on the
// frame) when the message cannot be read or has since been deleted —
// exactly ListPendingMessageRequests' own condition.
func (s *MessageService) canonicalRequestPreview(ctx context.Context, messageID int64) *DMRequestPreview {
	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil || msg == nil || msg.Deleted {
		return nil
	}
	return &DMRequestPreview{MessageID: msg.ID, Content: msg.Content, Timestamp: msg.Timestamp}
}
