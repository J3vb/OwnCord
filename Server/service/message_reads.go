package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// messageReadStore is what messageReads reads. *db.DB satisfies it.
type messageReadStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetMessagesAfterForAPI(ctx context.Context, channelID, after int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetMessagesAroundForAPI(ctx context.Context, channelID, centerID int64, beforeCount, afterCount int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetPinnedMessages(ctx context.Context, channelID, requestingUserID int64) ([]db.MessageAPIResponse, error)
	SearchMessagesFiltered(ctx context.Context, q db.SearchQuery, page db.SearchPage) ([]db.MessageSearchResult, error)
	GetReactionUsers(ctx context.Context, messageID int64, emoji string, limit int) ([]db.ReactionUser, error)
	ListChannels(ctx context.Context) ([]db.Channel, error)
	// GetMemberGrants fetches every held role's override and the per-user layer for
	// one member in batch queries: the single fetch behind every "what can this
	// member do here" site, so none pays an N+1.
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error)
}

// messageReads is MessageService's read side: history, pins, search, reaction
// users, the media gallery and the readable-channel sets. It writes nothing.
type messageReads struct {
	st    messageReadStore
	perms *PermissionService
	// media reads a channel's media gallery; nil disables it.
	media MediaStore
}

func newMessageReads(st messageReadStore, perms *PermissionService) *messageReads {
	r := &messageReads{st: st, perms: perms}
	r.media, _ = st.(MediaStore)
	return r
}
