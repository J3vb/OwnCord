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

// ClientInfo is a read-only snapshot of client state for V2 handlers, in place of
// a mutable *Client.
type ClientInfo struct {
	UserID   int64
	Username string
	Avatar   *string
	// DisplayName is the connection's nickname, nil when unset; renderers fall
	// back to the username.
	DisplayName    *string
	RoleName       string
	IdentityKey    string
	ReqID          string
	VoiceChannelID int64  // 0 if not in a voice channel
	VoiceJoinToken string // opaque join-instance token for the current voice session
	// Activity is the connection's live game when the frame was read. Frames of
	// one connection run one at a time, so it is current for activity_update and
	// presence_update.
	Activity *gameActivity
	// Listening is the connection's live song when the frame was read.
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
	// LiveStatus is Hub.LiveStatus: dm_channel_open presents each participant's
	// live status, not the users.status row.
	LiveStatus func(userID int64) string
	// LiveMobile is Hub.LiveMobile: each participant's phone flag; nil leaves
	// everyone off the phone.
	LiveMobile func(userID int64) bool
}

// PresenceDeps holds dependencies for presence, typing and channel focus handlers.
type PresenceDeps struct {
	Limiter    *auth.RateLimiter
	ChannelSvc *service.ChannelService
	// MessageSvc backs the DM half of typing_start's audience (the message-
	// request gate). nil falls back to ChannelSvc.GetDMParticipantIDs, the
	// unfiltered list.
	MessageSvc *service.MessageService
	// GameActivityEnabled is the per-server game activity switch; activity_update
	// refuses a set while false. nil means on.
	GameActivityEnabled func() bool
}

// ReactionDeps holds dependencies for reaction handlers.
type ReactionDeps struct {
	MessageSvc *service.MessageService
}

// VoiceTokenGenerator generates LiveKit access tokens, abstracted so V2 handlers
// test without LiveKit.
type VoiceTokenGenerator interface {
	GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canVideo, canScreenShare bool) (string, error)
	URL() string
}

// VoiceModerator applies the effects of a voice moderation action beyond the
// acting connection: the SFU and the target's socket. VoiceDeps carries the Hub
// itself so SetLiveKit's late wiring is picked up at call time.
type VoiceModerator interface {
	MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error
	// DisconnectFromVoice runs the voice-leave routine for the target's
	// connection; false when it has none on this node.
	DisconnectFromVoice(ctx context.Context, userID int64) bool
	// SendToVoiceDevice delivers a call frame (voice_moved, voice_disconnected)
	// to the device that held the call; false when none (the call was parked for
	// a reconnect).
	SendToVoiceDevice(userID int64, msg []byte) bool
}

// KeyHolderChecker reports whether a user is the E2EE key holder for a voice channel.
type KeyHolderChecker interface {
	IsVoiceKeyHolder(channelID, userID int64) bool
}

// PluginDeps holds dependencies for chat_command. Registry is a getter because
// SetPluginRegistry wires it after NewHub builds the deps. MessageSvc gates
// channel broadcasts through the same posting policy as a real send.
type PluginDeps struct {
	Registry   func() CommandDispatcher
	MessageSvc *service.MessageService
	Limiter    *auth.RateLimiter
}

// CommandDispatcher is the one registry method chat_command needs. An interface
// because without the wazero build tag a real registry has no runtime and the
// CanPost gate is unreachable from a test.
type CommandDispatcher interface {
	DispatchCommand(ctx context.Context, userID, channelID int64, cmd string, args []string) (*plugin.CommandResult, bool)
}

type VoiceDeps struct {
	// Voice is the voice family's service (every voice_states read and write);
	// Reader is the channel/role/DM side owned by other families.
	Voice       VoiceStore
	Reader      DispatchReader
	Limiter     *auth.RateLimiter
	Permissions *permissions.Checker
	// PermSvc is the cached permission service; when nil (tests with bare deps)
	// helpers use the live DB path and fail closed.
	PermSvc   *service.PermissionService
	LiveKit   *LiveKitClient
	TokenGen  VoiceTokenGenerator // used by voice_token_refresh V2
	KeyHolder KeyHolderChecker    // used by voice_token_refresh V2
	Mod       VoiceModerator      // used by the voice moderation handlers
	// Settings backs voice_mod_move's owner-only voice_owner_movable switch; nil
	// fails closed.
	Settings SettingsReader
}

// requirePerm checks a channel permission: nil if allowed, else a Result with
// INTERNAL (misconfiguration or lookup failure) or FORBIDDEN (bit genuinely
// absent), so operator-visible failures are not hidden behind a denial.
// A positive cached verdict is taken as-is (grants are invalidated synchronously
// at every mutation). A negative one falls through to the live path because the
// cache boolean cannot express INTERNAL vs FORBIDDEN; denials are rare, so the
// extra lookups happen only when the check is about to fail.
func requirePerm(ctx context.Context, database DispatchReader, perms *permissions.Checker, permSvc *service.PermissionService, userID, channelID, perm int64, label string) *Result {
	if permSvc != nil && permSvc.HasChannelPerm(ctx, userID, channelID, perm) {
		return nil
	}
	if database == nil || perms == nil {
		// A missing dependency is a server bug, not an ACL outcome; log so
		// operators see it.
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
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	if !perms.HasChannelPerm(ctx, role.Held(), userID, channelID, perm) {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing " + label + " permission"}}
		return &r
	}
	return nil
}

// hasPerm reports whether a channel permission is allowed: the cache with a
// PermissionService (false on lookup failure, fail closed), else per-call DB
// lookups.
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
// as a permissions.Subject (cache if wired, else live). Channel flags and DM
// state are the caller's to fill. A lookup failure is returned, not collapsed, so
// an error-aware caller (applySetChannelID's post-Subscribe revalidation) can
// tell it from a denial; a missing role row is the zero Subject, which every
// predicate refuses.
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

func (h *Hub) subjectFor(ctx context.Context, userID, channelID int64) (permissions.Subject, error) {
	return subjectFor(ctx, h.readers.Dispatch, h.permChecker, h.perms, userID, channelID)
}

// channelSubject is subjectFor plus the channel's flags and, for a DM, membership
// and (withBlock) block state, read live (never cached). An error is a lookup
// failure, never a denial.
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

// joinDenial maps a CanJoinVoice refusal to the voice_join error; a missing
// permission bit gets one neutral message that does not name it.
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

// HandlerV2 is the new-style handler signature: a typed Command, a read-only
// ClientInfo and a domain deps struct (passed as any; the handler asserts the
// type).
// TODO: replace `deps any` with generics (HandlerV2[D any]) for compile-time
// wiring; needs reworking the registry map.
type HandlerV2 func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result

func (h *Hub) canSeeLoadedChannel(ctx context.Context, userID int64, ch *db.Channel) bool {
	sub, err := channelSubject(ctx, h.readers.Dispatch, h.permChecker, h.perms, userID, ch, false)
	if err != nil {
		return false
	}
	return permissions.CanViewChannel(sub) == nil
}
