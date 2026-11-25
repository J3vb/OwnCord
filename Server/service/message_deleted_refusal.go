package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// deletedRefusalStore is what refuseDeletedMessage reads.
type deletedRefusalStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// refuseDeletedMessage is the answer to an edit or delete (action) of a soft-deleted row. Its author and a caller
// who can read its channel are told it is deleted (ErrDeletedMessage); anyone else gets the same ErrForbidden a
// live row in a channel they cannot read gets, so the answer depends only on what the caller may already see.
func refuseDeletedMessage(ctx context.Context, st deletedRefusalStore, perms *PermissionService, userID int64, msg *db.Message, action string) error {
	if msg.UserID == userID || canReadMessageChannel(ctx, st, perms, userID, msg.ChannelID) {
		return fmt.Errorf("%w: cannot %s this message", ErrDeletedMessage, action)
	}
	return fmt.Errorf("%w: cannot %s this message", ErrForbidden, action)
}

// canReadMessageChannel reports whether userID may view channelID. Any lookup failure answers false, so the
// caller falls back to the uniform refusal.
func canReadMessageChannel(ctx context.Context, st deletedRefusalStore, perms *PermissionService, userID, channelID int64) bool {
	ch, err := st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return false
	}
	sub, err := channelSubject(ctx, st, perms, userID, ch, false)
	return err == nil && permissions.CanViewChannel(sub) == nil
}
