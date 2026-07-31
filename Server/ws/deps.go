package ws

import (
	"context"
	"log/slog"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/service"
)

// ClientInfo holds a read-only snapshot of client state for V2 handlers.
// Handlers receive this instead of a mutable *Client pointer, making them
// easier to test and reason about.
type ClientInfo struct {
	UserID         int64
	Username       string
	Avatar         *string
	RoleName       string
	ReqID          string
	VoiceChannelID int64  // 0 if not in a voice channel
	VoiceJoinToken string // opaque join-instance token for the current voice session
}

// ── Per-domain dependency structs ───────────────────────────────────────────

// PingDeps holds dependencies for the ping handler.
type PingDeps struct {
	Limiter *auth.RateLimiter
}

// ChatDeps holds dependencies for chat handlers.
type ChatDeps struct {
	Limiter    *auth.RateLimiter
	MessageSvc *service.MessageService
}

// PresenceDeps holds dependencies for presence, typing, and channel focus handlers.
type PresenceDeps struct {
	Limiter    *auth.RateLimiter
	ChannelSvc *service.ChannelService
}

// ReactionDeps holds dependencies for reaction handlers.
type ReactionDeps struct {
	MessageSvc *service.MessageService
}

// VoiceTokenGenerator generates LiveKit access tokens. Abstracted so V2
// handlers can be tested without a real LiveKit server.
type VoiceTokenGenerator interface {
	GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canSubscribe, canVideo, canScreenShare bool) (string, error)
	URL() string
}

// KeyHolderChecker reports whether a user is the E2EE key holder for a voice channel.
type KeyHolderChecker interface {
	IsVoiceKeyHolder(channelID, userID int64) bool
}

// PluginDeps holds dependencies for the chat_command (plugin slash-command)
// handler. Registry is a getter, not a captured value, because the plugin
// registry is wired via SetPluginRegistry AFTER NewHub builds the deps; reading
// it live at dispatch time picks up the late wiring. MessageSvc gates channel
// broadcasts through the same posting policy as a real message send.
type PluginDeps struct {
	Registry   func() *plugin.Registry
	MessageSvc *service.MessageService
}

// VoiceDeps holds dependencies for voice handlers.
type VoiceDeps struct {
	DB          *db.DB
	Limiter     *auth.RateLimiter
	Permissions *permissions.Checker
	LiveKit     *LiveKitClient
	TokenGen    VoiceTokenGenerator // used by voice_token_refresh V2
	KeyHolder   KeyHolderChecker    // used by voice_token_refresh V2
}

// ── V2 permission helpers ───────────────────────────────────────────────────

// requirePerm checks a channel permission via DB lookups. Returns nil if
// allowed, or a Result carrying either an INTERNAL error (when the server
// is misconfigured or a DB lookup fails) or a FORBIDDEN error (when the
// permission bit is genuinely absent from the user's role). Previously
// every branch returned FORBIDDEN, which hid operator-visible failures
// behind a user-facing permission denial.
func requirePerm(ctx context.Context, database *db.DB, perms *permissions.Checker, userID, channelID, perm int64, label string) *Result {
	if database == nil || perms == nil {
		// Missing dependency is a server bug, not a user ACL outcome. Log
		// here so operators see something even when the client surfaces a
		// generic error.
		slog.Error("ws: requirePerm called with nil dependency",
			"have_database", database != nil, "have_perms", perms != nil, "label", label)
		r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "permission check unavailable"}}
		return &r
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil {
		slog.Error("ws: requirePerm GetRoleForUser failed",
			"user_id", userID, "channel_id", channelID, "err", err)
		r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "permission check failed"}}
		return &r
	}
	if role == nil {
		// No role row is a genuine ACL outcome (no role == no perms).
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	if !perms.HasChannelPerm(ctx, role.Permissions, role.ID, channelID, perm) {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	return nil
}

// hasPerm checks a channel permission via DB lookups. Returns true if allowed.
func hasPerm(ctx context.Context, database *db.DB, perms *permissions.Checker, userID, channelID, perm int64) bool {
	if database == nil || perms == nil {
		return false
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return false
	}
	return perms.HasChannelPerm(ctx, role.Permissions, role.ID, channelID, perm)
}

// hasChannelAccess is the gate to use when the channel id comes from the client:
// it is hasPerm plus the channel-type branch that role bits cannot express.
//
// A DM channel carries no channel_overrides rows, so a default Member's base
// bits satisfy hasPerm for ANY dm channel id — including a conversation the
// caller is not part of. permissions.Checker.RequireChannelAccess is the shared
// definition of channel access (service.PermissionService.RequireChannelAccess
// mirrors it for the REST/service paths) and supplies the IsDMParticipant
// branch, so the DM membership rule keeps exactly one implementation. Group DMs
// need no special case: dm_participants holds one row per participant and
// IsDMParticipant is a lookup on (user_id, channel_id).
//
// The role bit is still required on top, which RequireChannelAccess waives for
// DMs. Voice has always demanded CONNECT_VOICE and sweepStaleVoiceStates keeps
// re-checking it per role for every live participant, so keeping it here means
// this check can only ever narrow access — never hand someone a grant the old
// role-only check refused, and never let the sweeper evict a client the join
// gate admitted.
//
// Blocking is deliberately not consulted here: it is the message paths' rule
// (service.requireDMNotBlocked), it is two-party only, and a blocked user is
// still a participant, so it is orthogonal to the non-participant hole this
// closes.
func hasChannelAccess(ctx context.Context, database *db.DB, perms *permissions.Checker, userID, channelID, perm int64) bool {
	if database == nil || perms == nil {
		return false
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return false
	}
	if !perms.HasChannelPerm(ctx, role.Permissions, role.ID, channelID, perm) {
		return false
	}
	ch, err := database.GetChannel(ctx, channelID)
	if err != nil {
		// Fail closed: an unknown type would silently take the non-DM path.
		slog.Error("ws: hasChannelAccess GetChannel failed, denying",
			"user_id", userID, "channel_id", channelID, "err", err)
		return false
	}
	// A missing channel row takes the non-DM branch, i.e. the role verdict
	// above stands: there is no DM there to join, and callers keep reporting a
	// deleted channel the way they always have.
	if ch == nil || ch.Type != "dm" {
		// For every non-DM type, RequireChannelAccess is defined as exactly the
		// HasChannelPerm call already made above, so re-invoking it would only
		// repeat the same override lookup. The role verdict is the answer.
		return true
	}
	// DM: the role bit above stays required on top; the membership rule keeps
	// its single shared definition in RequireChannelAccess (IsDMParticipant),
	// which waives the role check for DMs.
	return perms.RequireChannelAccess(ctx, userID, role.Permissions, role.ID, ch.Type, channelID, perm) == nil
}

// ── V2 handler type ─────────────────────────────────────────────────────────

// HandlerV2 is the function signature for new-style (pure-ish) handlers.
// They receive a typed Command, a read-only ClientInfo snapshot, and a
// domain-specific deps struct (passed as any; handler asserts the concrete type).
// They return a Result describing what events to emit and any error.
// TODO: consider replacing `deps any` with generics (HandlerV2[D any]) to get
// compile-time type safety on deps wiring. Requires reworking the registry map.
type HandlerV2 func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result
