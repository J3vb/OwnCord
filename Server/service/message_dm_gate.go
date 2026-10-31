package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// dmFirstContactGate runs the gate for one non-sender participant (read with its
// trust of the sender by GetDMDeliveryTargets) of a one-to-one DM p.UserID just sent
// into. True means the send effect for this recipient is fully handled (a request
// was staged, or the recipient is unreachable and gets nothing): the caller skips
// OpenDM for them. False means the recipient trusts the sender and the OpenDM path
// applies. A recipient with message requests off is accepted and opened inside the
// gate's own transaction; the gate then marks target as trusting the sender and
// reports true.
func (s *dmDelivery) dmFirstContactGate(ctx context.Context, p SendMessageParams, target *db.DMDeliveryTarget, result *SendMessageResult) bool {
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
		// The recipient has message requests off: the transaction accepted the pair and
		// opened the DM, so mark the in-memory target trusting (delivery audience, mentions
		// and push include them), announce the open once, and send no dm_request frame.
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

// canonicalRequestPreview reads messageID fresh rather than trusting the send's
// cached content: the WS dm_request preview must agree with the REST inbox's
// (ListPendingMessageRequests joins first_message_id with deleted = 0), or a delete
// racing the frame leaves a stale preview on the wire while REST reports preview:
// null. nil (no preview) when the message cannot be read or was deleted, exactly
// that query's condition.
func (s *dmDelivery) canonicalRequestPreview(ctx context.Context, messageID int64) *DMRequestPreview {
	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil || msg == nil || msg.Deleted {
		return nil
	}
	return &DMRequestPreview{MessageID: msg.ID, Content: msg.Content, Timestamp: msg.Timestamp}
}
