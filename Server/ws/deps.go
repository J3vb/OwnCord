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

// ClientInfo is a read-only snapshot of client state for V2 handlers, in place of a
// mutable *Client, for easier testing.
type ClientInfo struct {
	UserID   int64
	Username string
	Avatar   *string
	// DisplayName is the connection's nickname, nil when unset. Carried alongside
	// Username: renderers fall back to the username and mentions resolve against it.
	DisplayName *string
	RoleName    string
	// IdentityKey is the device identity public key from the auth frame, "" if none.
	IdentityKey    string
	ReqID          string
	VoiceChannelID int64  // 0 if not in a voice channel
	VoiceJoinToken string // opaque join-instance token for the current voice session
	// Activity is the connection's live game when the frame was read, nil when none.
	// Frames of one connection run one at a time, so it is current for activity_update
	// (no-op and clear checks) and presence_update (the frame it emits).
	Activity *gameActivity
	// Listening is the connection's live song when the frame was read, nil when none
	// (listening_update's checks and the presence_update frame).
	Listening *listeningActivity
}

// PingDeps holds dependencies for the ping handler.
type PingDeps struct {
	Limiter *auth.RateLimiter
}

// ChatDeps holds dependencies for chat handlers.
type ChatDeps struct {
	Limiter    *auth.RateLimiter
	MessageSvc *service.MessageService
	// LiveStatus is Hub.LiveStatus: a send's dm_channel_open presents each
	// participant's live status, not the users.status row.
	LiveStatus func(userID int64) string
}

// PresenceDeps holds dependencies for presence, typing and channel focus handlers.
type PresenceDeps struct {
	Limiter    *auth.RateLimiter
	ChannelSvc *service.ChannelService
	// MessageSvc backs the DM half of typing_start's audience: the message-request gate
	// (MessageService.DMAudience) lives there, not on ChannelService. nil (a test
	// without it) falls back to ChannelSvc.GetDMParticipantIDs, the unfiltered list,
	// like MessageService.dmAudience's own nil fallback.
	MessageSvc *service.MessageService
	// GameActivityEnabled reports the per-server game activity switch: activity_update
	// refuses a set while false. nil means on (a test without a hub).
	GameActivityEnabled func() bool
}

// ReactionDeps holds dependencies for reaction handlers.
type ReactionDeps struct {
	MessageSvc *service.MessageService
}

// VoiceTokenGenerator generates LiveKit access tokens; abstracted so V2 handlers
// test without a LiveKit server.
type VoiceTokenGenerator interface {
	GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canVideo, canScreenShare bool) (string, error)
	URL() string
}

// VoiceModerator applies the effects of a voice moderation action that reach past
// the acting connection: the SFU and the target's socket. *Hub implements it and
// VoiceDeps carries the Hub itself so SetLiveKit's late wiring is picked up at
// call time (as VoiceTokenGenerator).
type VoiceModerator interface {
	// MuteParticipant mutes or unmutes the target's published audio at the SFU.
	MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error
	// DisconnectFromVoice runs the voice-leave routine for the target's connection.
	// Reports false when the target has no connection on this node.
	DisconnectFromVoice(ctx context.Context, userID int64) bool
	// SendToVoiceDevice delivers one call-related frame (voice_moved,
	// voice_disconnected) to the device that held the call, the connection the
	// voice-leave routine just took it from; other devices never see it. Reports false
	// when there is none (the call was parked for a reconnect).
	SendToVoiceDevice(userID int64, msg []byte) bool
}

// KeyHolderChecker reports whether a user is the E2EE key holder for a voice channel.
type KeyHolderChecker interface {
	IsVoiceKeyHolder(channelID, userID int64) bool
}

// PluginDeps holds dependencies for the chat_command (plugin slash-command)
// handler. Registry is a getter because the plugin registry is wired via
// SetPluginRegistry after NewHub builds the deps; reading it at dispatch picks up
// the late wiring. MessageSvc gates channel broadcasts through the same posting
// policy as a real send.
type PluginDeps struct {
	Registry   func() CommandDispatcher
	MessageSvc *service.MessageService
	Limiter    *auth.RateLimiter
}

// CommandDispatcher is the one method chat_command needs from the plugin registry
// (*plugin.Registry satisfies it). An interface keeps the broadcast path testable:
// without the wazero build tag a real registry has no runtime and only answers with
// a Reply, leaving the CanPost gate unreachable from a test.
type CommandDispatcher interface {
	DispatchCommand(ctx context.Context, userID, channelID int64, cmd string, args []string) (*plugin.CommandResult, bool)
}

type VoiceDeps struct {
	// Voice is the voice family's service (VoiceStore): every voice_states read and
	// write these handlers make. Reader is the channel/role/DM side of the same paths,
	// the rows a decision is taken against, which belong to other families.
	Voice       VoiceStore
	Reader      DispatchReader
	Limiter     *auth.RateLimiter
	Permissions *permissions.Checker
	// PermSvc is the cached permission service. When non-nil the permission helpers
	// answer from its per-user cache; when nil (tests with bare deps) they use the live
	// DB path and fail closed.
	PermSvc   *service.PermissionService
	LiveKit   *LiveKitClient
	TokenGen  VoiceTokenGenerator // used by voice_token_refresh V2
	KeyHolder KeyHolderChecker    // used by voice_token_refresh V2
	Mod       VoiceModerator      // used by the voice moderation handlers
	// Settings backs voice_mod_move's read of the owner-only voice_owner_movable
	// switch. Nil fails closed (the owner is not moved).
	Settings SettingsReader
}

// requirePerm checks a channel permission. Returns nil if allowed, else a Result
// with an INTERNAL error (misconfiguration or DB lookup failure) or a FORBIDDEN
// error (the bit is genuinely absent), so operator-visible failures are not hidden
// behind a permission denial.
//
// A positive verdict from the cached PermissionService is taken as-is (grants are
// invalidated synchronously at every mutation site). A negative verdict falls
// through to the live path because the cache's boolean cannot express
// INTERNAL-vs-FORBIDDEN; denials are rare so the extra lookups happen only when
// the check is about to fail anyway.
func requirePerm(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID, perm int64, label string) *Result {
	if permSvc != nil && permSvc.HasChannelPerm(ctx, userID, channelID, perm) {
		return nil
	}
	if database == nil || perms == nil {
		// A missing dependency is a server bug, not an ACL outcome. Log so operators see it
		// even when the client surfaces a generic error.
		slog.Error("ws: requirePerm called with nil dependency",
			"have_database", database != nil, "have_perms", perms != nil, "label", label)
		r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "permission check unavailable"}}
		return &r
	}
	role, err := database.GetMemberRoles(ctx, userID)
	if err != nil {
		slog.Error("ws: requirePerm GetMemberRoles failed",
			"user_id", userID, "channel_id", channelID, "err", err)
		r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "permission check failed"}}
		return &r
	}
	if role == nil {
		// No role row is a genuine ACL outcome (no role, no perms).
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	if !perms.HasChannelPerm(ctx, role.Held(), userID, channelID, perm) {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	return nil
}

// hasPerm reports whether a channel permission is allowed. With a PermissionService
// the answer is its per-user cache (false on any lookup failure, fail closed);
// without one it does per-call DB lookups.
func hasPerm(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID, perm int64) bool {
	if permSvc != nil {
		return permSvc.HasChannelPerm(ctx, userID, channelID, perm)
	}
	if database == nil || perms == nil {
		return false
	}
	role, err := database.GetMemberRoles(ctx, userID)
	if err != nil || role == nil {
		return false
	}
	return perms.HasChannelPerm(ctx, role.Held(), userID, channelID, perm)
}

// subjectFor resolves userID's role bits and both override layers for channelID
// (from the PermissionService cache if wired, else live through the Checker) as a
// permissions.Subject for the value-taking predicates (CanSendMessage,
// CanJoinVoice, ...). Channel flags and DM state stay the caller's to fill. A
// lookup failure is returned, not collapsed (hasPerm and hasChannelAccess collapse
// it to false, right for gates sending FORBIDDEN), so an error-aware caller like
// applySetChannelID's post-Subscribe revalidation can tell a read failure from a
// denial; a missing role row is the zero Subject, which every predicate refuses.
func subjectFor(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID int64) (permissions.Subject, error) {
	if permSvc != nil {
		return permSvc.Subject(ctx, userID, channelID)
	}
	if database == nil || perms == nil {
		return permissions.Subject{}, nil
	}
	role, err := database.GetMemberRoles(ctx, userID)
	if err != nil {
		return permissions.Subject{}, err
	}
	if role == nil {
		return permissions.Subject{}, nil
	}
	return perms.Subject(ctx, role.Held(), userID, channelID)
}

// subjectFor on the hub: the hub-wired form of the package-level subjectFor.
func (h *Hub) subjectFor(ctx context.Context, userID, channelID int64) (permissions.Subject, error) {
	return subjectFor(ctx, h.readers.Dispatch, h.permChecker, h.perms, userID, channelID)
}

// channelSubject is subjectFor plus the channel's flags and, for a DM, membership
// and (withBlock) two-party block state, everything CanJoinVoice and
// CanModerateVoice consult. Membership and blocks are always read live
// (dm_participants is membership state, never cached). An error is a lookup
// failure, never a denial; callers decide whether that fails closed.
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
		switch err := service.RequireDMReachable(ctx, database, userID, ch.ID); {
		case errors.Is(err, service.ErrBlocked):
			sub.DMBlocked = true
		case err != nil:
			return permissions.Subject{}, err
		}
	}
	return sub, nil
}

// joinDenial maps a CanJoinVoice refusal to the voice_join error frame. A missing
// permission bit gets one neutral message that does not name the bit.
func joinDenial(err error) ClientError {
	switch {
	case errors.Is(err, permissions.ErrNotVoiceChannel):
		return ClientError{Code: ErrCodeBadRequest, Message: "not a voice channel"}
	case errors.Is(err, permissions.ErrArchived):
		return ClientError{Code: ErrCodeBadRequest, Message: "channel is archived"}
	case errors.Is(err, permissions.ErrBlocked):
		return ClientError{Code: ErrCodeForbidden, Message: "cannot join this call"}
	case errors.Is(err, permissions.ErrTimedOut):
		return ClientError{Code: ErrCodeTimedOut, Message: "you are timed out"}
	default:
		return ClientError{Code: ErrCodeForbidden, Message: "missing permission to join this voice channel"}
	}
}

// HandlerV2 is the signature for new-style handlers: a typed Command, a read-only
// ClientInfo and a domain deps struct (passed as any; the handler asserts the
// concrete type), returning a Result of events and any error.
// TODO: replace `deps any` with generics (HandlerV2[D any]) for compile-time deps
// wiring; needs reworking the registry map.
type HandlerV2 func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result
