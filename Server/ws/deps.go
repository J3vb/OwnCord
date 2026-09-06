package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

// ClientInfo holds a read-only snapshot of client state for V2 handlers.
// Handlers receive this instead of a mutable *Client pointer, making them
// easier to test and reason about.
type ClientInfo struct {
	UserID   int64
	Username string
	Avatar   *string
	// DisplayName is the connection's nickname, nil when unset. Carried
	// alongside Username rather than replacing it: renderers fall back to the
	// username, and mentions still resolve against it.
	DisplayName    *string
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

// VoiceModerator applies the effects of a voice moderation action that reach
// past the acting connection: the SFU and the target's own socket. *Hub
// implements it, and VoiceDeps carries the Hub itself so SetLiveKit's late
// wiring is picked up at call time (same reason as VoiceTokenGenerator).
type VoiceModerator interface {
	// MuteParticipant mutes or unmutes the target's published audio at the SFU.
	MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error
	// DisconnectFromVoice runs the voice-leave routine for the target's
	// connection. Reports false when the target has no connection on this node.
	DisconnectFromVoice(ctx context.Context, userID int64) bool
	// SendToUser delivers one server->client frame to the target.
	SendToUser(userID int64, msg []byte) bool
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
	Registry   func() CommandDispatcher
	MessageSvc *service.MessageService
	Limiter    *auth.RateLimiter
}

// CommandDispatcher is the one method the chat_command handler needs from the
// plugin registry; *plugin.Registry satisfies it. Taking the interface rather
// than the concrete type is what makes the broadcast path testable: without
// the wazero build tag a real registry has no runtime and can only ever answer
// with a Reply, so the CanPost gate would otherwise be unreachable from a test.
type CommandDispatcher interface {
	DispatchCommand(ctx context.Context, userID, channelID int64, cmd string, args []string) (*plugin.CommandResult, bool)
}

// VoiceDeps holds dependencies for voice handlers.
type VoiceDeps struct {
	// Voice is the voice family's service (readers.go's VoiceStore): every
	// voice_states read and write these handlers make. Reader is the
	// channel/role/DM side of the same paths — the rows a voice decision is
	// taken AGAINST, which belong to other families and are read through the
	// dispatch seam.
	Voice       VoiceStore
	Reader      DispatchReader
	Limiter     *auth.RateLimiter
	Permissions *permissions.Checker
	// PermSvc is the cached permission service. When non-nil the permission
	// helpers below answer from its per-user cache instead of per-call role and
	// override queries; when nil (tests constructing bare deps) they keep the
	// live DB path and fail closed exactly as before.
	PermSvc   *service.PermissionService
	LiveKit   *LiveKitClient
	TokenGen  VoiceTokenGenerator // used by voice_token_refresh V2
	KeyHolder KeyHolderChecker    // used by voice_token_refresh V2
	Mod       VoiceModerator      // used by the voice moderation handlers
}

// ── V2 permission helpers ───────────────────────────────────────────────────

// requirePerm checks a channel permission. Returns nil if allowed, or a Result
// carrying either an INTERNAL error (when the server is misconfigured or a DB
// lookup fails) or a FORBIDDEN error (when the permission bit is genuinely
// absent from the user's role). Previously every branch returned FORBIDDEN,
// which hid operator-visible failures behind a user-facing permission denial.
//
// A positive verdict from the cached PermissionService is taken as-is (grants
// are invalidated synchronously at every mutation site, so it cannot be a
// stale allow beyond the invalidation contract). A negative verdict falls
// through to the live path because the cache's boolean cannot express the
// INTERNAL-vs-FORBIDDEN distinction above — denials are the rare case, so the
// extra lookups only happen when the check is about to fail anyway.
func requirePerm(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID, perm int64, label string) *Result {
	if permSvc != nil && permSvc.HasChannelPerm(ctx, userID, channelID, perm) {
		return nil
	}
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
	if !perms.HasChannelPerm(ctx, role.Permissions, role.ID, userID, channelID, perm) {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	return nil
}

// hasPerm checks a channel permission. Returns true if allowed. With a
// PermissionService the answer comes from its per-user cache (false on any
// lookup failure, same fail-closed posture as the live path); without one it
// falls back to per-call DB lookups.
func hasPerm(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID, perm int64) bool {
	if permSvc != nil {
		return permSvc.HasChannelPerm(ctx, userID, channelID, perm)
	}
	if database == nil || perms == nil {
		return false
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return false
	}
	return perms.HasChannelPerm(ctx, role.Permissions, role.ID, userID, channelID, perm)
}

// subjectFor resolves userID's role bits and both override layers for
// channelID — from the PermissionService cache when one is wired, else live
// through the Checker — as a permissions.Subject for the value-taking
// predicates (CanSendMessage, CanJoinVoice, ...). Channel flags and DM state
// stay the caller's to fill in. A lookup failure is returned, not collapsed
// (hasPerm and hasChannelAccess collapse it to a fail-closed false, the right
// posture for every gate that sends FORBIDDEN on denial), so an error-aware
// caller like applySetChannelID's post-Subscribe revalidation (OC-0266) can
// tell a transient read failure from a denial; a missing role row is the
// zero Subject, which every predicate refuses.
func subjectFor(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID int64) (permissions.Subject, error) {
	if permSvc != nil {
		return permSvc.Subject(ctx, userID, channelID)
	}
	if database == nil || perms == nil {
		return permissions.Subject{}, nil
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil {
		return permissions.Subject{}, err
	}
	if role == nil {
		return permissions.Subject{}, nil
	}
	return perms.Subject(ctx, role.Permissions, role.ID, userID, channelID)
}

// subjectFor is the hub-wired form of the package-level subjectFor.
func (h *Hub) subjectFor(ctx context.Context, userID, channelID int64) (permissions.Subject, error) {
	return subjectFor(ctx, h.db, h.permChecker, h.perms, userID, channelID)
}

// channelSubject is subjectFor plus the channel's flags and, for a DM, the
// membership and (withBlock) two-party block state — everything CanJoinVoice
// and CanModerateVoice consult. Membership and blocks are always read live
// (dm_participants rows are membership, not permission, state and are never
// cached). An error is a lookup failure, never a denial; callers decide
// whether that fails closed.
func channelSubject(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID int64, ch *db.Channel, withBlock bool) (permissions.Subject, error) {
	sub, err := subjectFor(ctx, database, perms, permSvc, userID, ch.ID)
	if err != nil {
		return permissions.Subject{}, err
	}
	sub.Channel = channelRef(ch)
	if ch.Type != "dm" || database == nil {
		return sub, nil
	}
	ok, err := database.IsDMParticipant(ctx, userID, ch.ID)
	if err != nil {
		return permissions.Subject{}, err
	}
	sub.DMParticipant = ok
	if ok && withBlock {
		switch err := service.RequireDMNotBlocked(ctx, database, userID, ch.ID); {
		case errors.Is(err, service.ErrBlocked):
			sub.DMBlocked = true
		case err != nil:
			return permissions.Subject{}, err
		}
	}
	return sub, nil
}

// joinDenial maps a CanJoinVoice refusal to the error frame the voice_join
// gate has always sent for that reason.
func joinDenial(err error) ClientError {
	switch {
	case errors.Is(err, permissions.ErrNotVoiceChannel):
		return ClientError{Code: ErrCodeBadRequest, Message: "not a voice channel"}
	case errors.Is(err, permissions.ErrArchived):
		return ClientError{Code: ErrCodeBadRequest, Message: "channel is archived"}
	case errors.Is(err, permissions.ErrBlocked):
		return ClientError{Code: ErrCodeForbidden, Message: "cannot join voice: blocked"}
	case errors.Is(err, permissions.ErrTimedOut):
		return ClientError{Code: ErrCodeTimedOut, Message: "you are timed out"}
	default:
		return ClientError{Code: ErrCodeForbidden, Message: "missing CONNECT_VOICE permission"}
	}
}

// ── V2 handler type ─────────────────────────────────────────────────────────

// HandlerV2 is the function signature for new-style (pure-ish) handlers.
// They receive a typed Command, a read-only ClientInfo snapshot, and a
// domain-specific deps struct (passed as any; handler asserts the concrete type).
// They return a Result describing what events to emit and any error.
// TODO: consider replacing `deps any` with generics (HandlerV2[D any]) to get
// compile-time type safety on deps wiring. Requires reworking the registry map.
type HandlerV2 func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result
