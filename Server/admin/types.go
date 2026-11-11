package admin

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

type adminContextKey int

const (
	adminUserKey adminContextKey = iota
	// adminRoleKey holds the principal's *db.Role, set by adminAuthMiddleware so requirePerm and /me need no
	// second query.
	adminRoleKey
	adminSessionKey
	// adminTokenHashKey holds the hash of the bearer credential (session or API token) that authenticated the
	// request; unlike adminSessionKey it is set for both kinds.
	adminTokenHashKey
)

// HubBroadcaster is the subset of ws.Hub needed by the admin package.
type HubBroadcaster interface {
	BroadcastServerRestart(reason ws.RestartReason, delaySeconds int)
	BroadcastChannelCreate(ch *db.Channel)
	BroadcastChannelUpdate(ch *db.Channel)
	BroadcastChannelDelete(channelID int64)
	// BroadcastChannelCategories sends the category list after a mutation only to clients holding
	// MANAGE_CHANNELS (evaluated at send time).
	BroadcastChannelCategories(cats []db.ChannelCategory)
	BroadcastMemberBan(userID int64)
	// BroadcastChatBulkDeleted tells a channel's subscribers that messageIDs were deleted at once (a ban's
	// message purge).
	BroadcastChatBulkDeleted(channelID int64, messageIDs []int64)
	// RefreshChannelVisibility sends targeted channel_create/channel_delete after a permission override change
	// so sidebars update without a reconnect.
	RefreshChannelVisibility(ch *db.Channel)
	// BroadcastRolesUpdate ships the role list to every client after a role mutation.
	BroadcastRolesUpdate(roles []*db.Role)
	// CleanupVoiceForChannel evicts a channel's voice participants; it must run BEFORE the channel row is
	// deleted: the voice_states FK cascade wipes the rows the cleanup reads.
	CleanupVoiceForChannel(channelID int64)
	// UserCount is the number of distinct connected users (two devices count once).
	UserCount() int
}

// PermissionInvalidator is accepted by the admin constructors but unused (the services invalidate the cache
// themselves); kept so constructor signatures stay unchanged.
type PermissionInvalidator interface {
	InvalidateUser(userID int64)
	InvalidateAll()
}

// adminUserResponse is the public user shape; it deliberately excludes PasswordHash and TOTPSecret.
type adminUserResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	// DisplayName is the nickname; only the users list sets it.
	DisplayName *string `json:"display_name,omitempty"`
	Avatar      *string `json:"avatar,omitempty"`
	RoleID      int64   `json:"role_id"`
	RoleName    string  `json:"role_name"`
	// RolePosition and RoleIDs (top role first) are set only by the users list.
	RolePosition *int    `json:"role_position,omitempty"`
	RoleIDs      []int64 `json:"role_ids,omitempty"`
	Status       string  `json:"status"`
	CreatedAt    string  `json:"created_at"`
	LastSeen     *string `json:"last_seen,omitempty"`
	Banned       bool    `json:"banned"`
	BanReason    *string `json:"ban_reason,omitempty"`
	BanExpires   *string `json:"ban_expires,omitempty"`
}

// adminMeResponse describes the calling principal so the panel can hide surfaces its role cannot use; an
// affordance hint only, every route re-checks the bit server-side.
type adminMeResponse struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	RoleID       int64  `json:"role_id"`
	RoleName     string `json:"role_name"`
	RolePosition int    `json:"role_position"`
	Permissions  int64  `json:"permissions"`
	// IsOwner mirrors ownerOnlyMiddleware: owner-only routes gate on position,
	// not on a permission bit, so the panel cannot derive this from the mask.
	IsOwner bool `json:"is_owner"`
	// ServerName and Version fill the top bar; Version is only for authenticated panel principals.
	ServerName string `json:"server_name"`
	Version    string `json:"version,omitempty"`
}

func toAdminUserResponse(u *db.User, roleName string) adminUserResponse {
	return adminUserResponse{
		ID:         u.ID,
		Username:   u.Username,
		Avatar:     u.Avatar,
		RoleID:     u.RoleID,
		RoleName:   roleName,
		Status:     u.Status,
		CreatedAt:  u.CreatedAt,
		LastSeen:   u.LastSeen,
		Banned:     u.Banned,
		BanReason:  u.BanReason,
		BanExpires: u.BanExpires,
	}
}
