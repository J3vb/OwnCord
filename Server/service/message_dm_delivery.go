package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

type dmDeliveryStore interface {
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	OpenDM(ctx context.Context, userID, channelID int64) (bool, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []db.DMDeliveryTarget, err error)
	GetGroupDMMeta(ctx context.Context, channelID int64) (ownerID int64, iconID string, err error)
	GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]db.DMUser, error)
	TrustSender(ctx context.Context, recipientID, senderID int64, source string) error
}

type dmDelivery struct {
	st dmDeliveryStore
	// messageRequests is the first-contact gate and delivery-audience filter, wired by
	// service.New(). Nil (tests, NewMessageService callers) disables the gate.
	messageRequests *MessageRequestService
	// afterFirstContactTrustCheck is a test seam called from dmFirstContactGate once the
	// recipient's trust reads false, before firstContact's insert. Nil in production.
	afterFirstContactTrustCheck func()
	// beforeRequestPreviewLookup is a test seam called right before canonicalRequestPreview's
	// DB read so a test can delete the message in that window. Nil in production.
	beforeRequestPreviewLookup func(messageID int64)
}
