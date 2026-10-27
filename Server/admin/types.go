package admin

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── Context keys ─────────────────────────────────────────────────────────────

// adminContextKey is an unexported type for context keys in the admin package.
type adminContextKey int

const (
	// adminUserKey is the context key for the authenticated *db.User.
	adminUserKey adminContextKey = iota
	// adminRoleKey is the context key for the authenticated principal's
	// *db.Role. Set by adminAuthMiddleware so requirePerm and the /me handler
	// need no second query.
	adminRoleKey
	// adminSessionKey is the context key for the authenticated *db.Session.
	adminSessionKey
	// adminTokenHashKey is the context key for the hash (string) of the bearer
	// credential that authenticated the request — a login session or an API
	// token. Unlike adminSessionKey it is set for both principal kinds.
	adminTokenHashKey
)

// ─── HubBroadcaster ──────────────────────────────────────────────────────────

// HubBroadcaster is the subset of ws.Hub needed by the admin package.
type HubBroadcaster interface {
	BroadcastServerRestart(reason ws.RestartReason, delaySeconds int)
	BroadcastChannelCreate(ch *db.Channel)
	BroadcastChannelUpdate(ch *db.Channel)
	BroadcastChannelDelete(channelID int64)
	// BroadcastChannelCategories sends the full category list to the connected
	// clients that hold MANAGE_CHANNELS (permission evaluated at send time),
	// and to nobody else, after a category mutation (WP 6.5a).
	BroadcastChannelCategories(cats []db.ChannelCategory)
	BroadcastMemberBan(userID int64)
	// BroadcastChatBulkDeleted tells a channel's subscribers that messageIDs
	// were deleted at once (one committed batch of a ban's message purge).
	BroadcastChatBulkDeleted(channelID int64, messageIDs []int64)
	// RefreshChannelVisibility sends targeted channel_create/channel_delete
	// messages after a channel permission override change so each connected
	// client's sidebar reflects its new visibility without a reconnect.
	RefreshChannelVisibility(ch *db.Channel)
	// BroadcastRolesUpdate ships the full role list to every connected client
	// after a role mutation, so name colors and permission-gated affordances
	// converge without a reconnect.
	BroadcastRolesUpdate(roles []*db.Role)
	// CleanupVoiceForChannel evicts a channel's voice participants (DB row,
	// client state, LiveKit, voice_leave broadcast). Must run BEFORE the
	// channel row is deleted: the voice_states FK cascade wipes the rows the
	// cleanup reads.
	CleanupVoiceForChannel(channelID int64)
	// UserCount is the number of distinct connected users (an account on two
	// devices counts once).
	UserCount() int
}

// ─── PermissionInvalidator ───────────────────────────────────────────────────

// PermissionInvalidator was how admin handlers invalidated the permission cache
// when roles or permissions changed. Since WP 5.1a the services do that
// themselves (service.PermissionChangeNotifier's callers invalidate first), so
// the admin constructors accept the value but no longer use it; it is kept so
// their signatures, and every caller, stay unchanged. Satisfied by
// *service.PermissionService.
type PermissionInvalidator interface {
	InvalidateUser(userID int64)
	InvalidateAll()
}

// ─── adminUserResponse ──────────────────────────────────────────────────────

// adminUserResponse is the safe public shape returned by user-listing and
// user-patch endpoints. It deliberately excludes PasswordHash and TOTPSecret.
type adminUserResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	// DisplayName is the member's nickname; only the users list sets it, and
	// it is omitted when unset.
	DisplayName *string `json:"display_name,omitempty"`
	Avatar      *string `json:"avatar,omitempty"`
	RoleID      int64   `json:"role_id"`
	RoleName    string  `json:"role_name"`
	// RolePosition is the role's hierarchy position; only the users list
	// sets it.
	RolePosition *int `json:"role_position,omitempty"`
	// RoleIDs is every held role, top role first; only the users list sets it.
	RoleIDs    []int64 `json:"role_ids,omitempty"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
	LastSeen   *string `json:"last_seen,omitempty"`
	Banned     bool    `json:"banned"`
	BanReason  *string `json:"ban_reason,omitempty"`
	BanExpires *string `json:"ban_expires,omitempty"`
}

// ─── adminMeResponse ────────────────────────────────────────────────────────

// adminMeResponse describes the calling principal to the admin panel so it can
// hide the surfaces the principal's role cannot use. It is an affordance hint
// only — every route re-checks the bit server-side.
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
	// ServerName and Version fill the panel's top bar. Only authenticated
	// panel principals see Version; unauthenticated endpoints never carry it.
	ServerName string `json:"server_name"`
	Version    string `json:"version,omitempty"`
}

// toAdminUserResponse converts a db.User and its resolved role name to the
// safe response shape.
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
