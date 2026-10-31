package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// dmDeliveryStore is what dmDelivery reads and writes. *db.DB satisfies it.
type dmDeliveryStore interface {
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	OpenDM(ctx context.Context, userID, channelID int64) (bool, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []db.DMDeliveryTarget, err error)
	GetGroupDMMeta(ctx context.Context, channelID int64) (ownerID int64, iconID string, err error)
	GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]db.DMUser, error)
}

// dmDelivery is the DM side of a send: who a DM message reaches, the
// first-contact gate, and the group owner on the result.
type dmDelivery struct {
	st dmDeliveryStore
	// messageRequests is the first-contact gate and delivery-audience filter, wired
	// by service.New(). Nil (tests and NewMessageService callers) disables the gate,
	// so 1:1 DMs behave as before it existed.
	messageRequests *MessageRequestService
	// afterFirstContactTrustCheck is a test seam called from dmFirstContactGate once
	// the recipient's trust is read false, before firstContact's insert (no exported
	// setter, like storage_quota.go's afterRecount). Nil in production.
	afterFirstContactTrustCheck func()
	// beforeRequestPreviewLookup is a test seam called right before
	// canonicalRequestPreview's DB read so a test can delete the held message in
	// that window and confirm the preview comes back nil. Nil in production.
	beforeRequestPreviewLookup func(messageID int64)
}
