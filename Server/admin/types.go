package admin

import "github.com/owncord/server/db"

// ─── Context keys ─────────────────────────────────────────────────────────────

// adminContextKey is an unexported type for context keys in the admin package.
type adminContextKey int

const (
	// adminUserKey is the context key for the authenticated *db.User.
	adminUserKey adminContextKey = iota
	// adminSessionKey is the context key for the authenticated *db.Session.
	adminSessionKey
)

// ─── Allowed settings keys ────────────────────────────────────────────────────

// allowedSettingKeys is the whitelist of keys that may be written via
// PATCH /admin/api/settings. Derived from the settings table in SCHEMA.md.
var allowedSettingKeys = map[string]struct{}{
	"server_name":       {},
	"server_icon":       {},
	"motd":              {},
	"max_upload_bytes":  {},
	"voice_quality":     {},
	"require_2fa":       {},
	"registration_open": {},
	"backup_schedule":   {},
	"backup_retention":  {},
}

// ─── HubBroadcaster ──────────────────────────────────────────────────────────

// HubBroadcaster is the subset of ws.Hub needed by the admin package.
type HubBroadcaster interface {
	BroadcastServerRestart(reason string, delaySeconds int)
	BroadcastChannelCreate(ch *db.Channel)
	BroadcastChannelUpdate(ch *db.Channel)
	BroadcastChannelDelete(channelID int64)
	BroadcastMemberBan(userID int64)
	BroadcastMemberUpdate(userID int64, roleName string)
	ClientCount() int
}

// ─── adminUserResponse ──────────────────────────────────────────────────────

// adminUserResponse is the safe public shape returned by user-listing and
// user-patch endpoints. It deliberately excludes PasswordHash and TOTPSecret.
type adminUserResponse struct {
	ID         int64   `json:"id"`
	Username   string  `json:"username"`
	Avatar     *string `json:"avatar,omitempty"`
	RoleID     int64   `json:"role_id"`
	RoleName   string  `json:"role_name"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
	LastSeen   *string `json:"last_seen,omitempty"`
	Banned     bool    `json:"banned"`
	BanReason  *string `json:"ban_reason,omitempty"`
	BanExpires *string `json:"ban_expires,omitempty"`
}

// toAdminUserResponse converts a db.UserWithRole to the safe response shape.
func toAdminUserResponse(u db.UserWithRole) adminUserResponse {
	return adminUserResponse{
		ID:         u.ID,
		Username:   u.Username,
		Avatar:     u.Avatar,
		RoleID:     u.RoleID,
		RoleName:   u.RoleName,
		Status:     u.Status,
		CreatedAt:  u.CreatedAt,
		LastSeen:   u.LastSeen,
		Banned:     u.Banned,
		BanReason:  u.BanReason,
		BanExpires: u.BanExpires,
	}
}

// toAdminUserResponseFromUser converts a plain db.User to the safe response
// shape, resolving the role name via the database.
func toAdminUserResponseFromUser(database *db.DB, u *db.User) adminUserResponse {
	roleName := ""
	if role, err := database.GetRoleByID(u.RoleID); err == nil && role != nil {
		roleName = role.Name
	}
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
