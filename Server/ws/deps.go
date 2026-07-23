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

// ── V2 handler type ─────────────────────────────────────────────────────────

// HandlerV2 is the function signature for new-style (pure-ish) handlers.
// They receive a typed Command, a read-only ClientInfo snapshot, and a
// domain-specific deps struct (passed as any; handler asserts the concrete type).
// They return a Result describing what events to emit and any error.
// TODO: consider replacing `deps any` with generics (HandlerV2[D any]) to get
// compile-time type safety on deps wiring. Requires reworking the registry map.
type HandlerV2 func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result
