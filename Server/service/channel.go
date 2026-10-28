package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ChannelService handles channel-related business logic including
// listing, permission-filtered access, typing, presence, and read state.
type ChannelService struct {
	st    Store
	afk   AFKStore
	cats  CategoryStore
	cperm CategoryPermStore
	forum ForumStore
	perms *PermissionService
	batch *ConnWrites
	// notifier re-derives channel audiences after an override change (WP
	// 5.1a). Set once before the server serves; nil is a no-op.
	notifier PermissionChangeNotifier
	// wakeExpiry nudges the custom status expirer after a status with an
	// expiry commits; nil when none is installed.
	wakeExpiry func()
	now        func() time.Time
}

// NewChannelService creates a ChannelService.
func NewChannelService(st Store, perms *PermissionService) *ChannelService {
	// The AFK pointer lives on a slice interface rather than on Store, which
	// is ratcheted (datastore_ratchet_test.go). *db.DB satisfies it; a Store
	// that does not leaves SetAFKChannel answering ErrInternal.
	afk, _ := st.(AFKStore)
	cats, _ := st.(CategoryStore)
	cperm, _ := st.(CategoryPermStore)
	forum, _ := st.(ForumStore)
	return &ChannelService{
		st:    st,
		afk:   afk,
		cats:  cats,
		cperm: cperm,
		forum: forum,
		perms: perms,
		now:   time.Now,
	}
}

// SetExpiryWake installs the callback a committed custom status with an
// expiry calls so the expirer re-reads its deadline. Call once at startup,
// before the service is shared.
func (s *ChannelService) SetExpiryWake(wake func()) { s.wakeExpiry = wake }

// SetConnWrites installs the batch whose pending connect stamp a committed
// presence_update drops. Call once at startup, before the service is shared.
func (s *ChannelService) SetConnWrites(w *ConnWrites) { s.batch = w }

// ListVisibleChannels returns channels the user has ReadMessages permission for.
// DM channels are excluded (they are accessed via DMService).
func (s *ChannelService) ListVisibleChannels(ctx context.Context, userID int64) ([]db.Channel, error) {
	// Phase B Step 8 — span the public service entrypoint.
	ctx, done := traceCall(ctx, "service/channel", "ChannelService.ListVisibleChannels",
		telemetry.Int64("user_id", userID),
	)
	defer done()
	all, err := s.st.ListChannels(ctx)
	if err != nil {
		slog.Error("ChannelService.ListVisibleChannels", "err", err)
		return nil, fmt.Errorf("%w: failed to list channels", ErrInternal)
	}

	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		slog.Error("ChannelService.ListVisibleChannels GetRoleForUser", "err", err, "user_id", userID)
		return nil, fmt.Errorf("%w: failed to get role", ErrInternal)
	}

	// Admins skip the override fetch (they bypass all channel checks anyway).
	// Non-admins get every held role's override and the per-user layer in one
	// batched fetch.
	grants := permissions.MemberGrants{Perms: role.Perms}
	if !permissions.HasAdmin(role.Perms) {
		grants, err = s.st.GetMemberGrants(ctx, userID)
		if err != nil {
			// Fail closed — an empty map would return every denied channel.
			slog.Error("ChannelService.ListVisibleChannels GetMemberGrants", "err", err, "user_id", userID, "role_ids", role.IDs)
			return nil, fmt.Errorf("%w: failed to fetch channel overrides", ErrInternal)
		}
		grants.Perms = role.Perms
	}

	// Single visibility predicate shared with the ws ready payload and reconnect
	// replay filtering, so REST and WS can never disagree on what a role sees.
	visibleIDs := s.perms.Checker().VisibleChannelIDs(grants, channelRefs(all))
	visible := make([]db.Channel, 0, len(visibleIDs))
	for i := range all {
		if visibleIDs[all[i].ID] {
			visible = append(visible, all[i])
		}
	}
	return visible, nil
}

// channelRefs maps db channels to the checker's db-agnostic ChannelRef.
func channelRefs(channels []db.Channel) []permissions.ChannelRef {
	refs := make([]permissions.ChannelRef, len(channels))
	for i := range channels {
		refs[i] = permissions.ChannelRef{ID: channels[i].ID, Type: channels[i].Type, Archived: channels[i].Archived,
			NSFW: channels[i].NSFW, AuthorityID: channels[i].Thread.ParentID, ThreadLocked: channels[i].Thread.Locked}
	}
	return refs
}

// HandleTyping processes a typing start event for a channel.
// Returns the channel so callers can build broadcast events.
// Silent errors are returned as nil (typing indicators are best-effort).
func (s *ChannelService) HandleTyping(ctx context.Context, userID, channelID int64, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, nil
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, nil //nolint:nilerr // typing indicators are best-effort; errors silently dropped
	}

	// A forum holds no messages, so there is nothing to type into: silent
	// like every other typing refusal (a send is refused in checkSendPermission).
	if ch.Type == db.ForumTypeName {
		return nil, nil
	}

	// A typing indicator announces a post, so it answers to the post policy
	// (permissions.CanType is CanSendMessage — S-01): a read-only member, an
	// announcement reader without MANAGE_MESSAGES, an archived channel, a
	// blocked or non-participant DM user all emit nothing. Silent, because
	// typing is best-effort.
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if subErr != nil || permissions.CanType(sub) != nil {
		return nil, nil //nolint:nilerr // best-effort: a denial or a DM lookup failure emits nothing
	}

	// Per-user-per-channel rate limit. Built only now that the channel is
	// known to exist and the caller is authorized to read it (OC-0202): doing
	// this before resolution let any caller-supplied channel id — including
	// ids that don't exist or aren't readable — pin a new entry in the
	// shared, process-wide RateLimiter. RateLimiter.Cleanup only evicts a key
	// once every timestamp on it is stale, so a stream of forged channel ids
	// could retain an unbounded number of dead map entries for hours.
	ratKey := auth.Key(auth.Key("typing", userID), channelID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 3*time.Second) {
		return nil, nil
	}

	return ch, nil
}

// GetDMParticipantIDs returns the participant IDs for a DM channel.
// Convenience method for handlers building DM events.
func (s *ChannelService) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	return s.st.GetDMParticipantIDs(ctx, channelID)
}

// PresenceResult is what a committed presence_update leaves on the wire.
type PresenceResult struct {
	// CustomStatus is the sanitized line to publish (nil = none).
	CustomStatus *string
	// ExpiresAt is the stored expiry of CustomStatus in
	// dbtime.ISOLayout, "" when it has none. For a bare status flip
	// it is the expiry already stored with the text it carries.
	ExpiresAt string
}

// HandlePresenceUpdate validates and persists a presence status change, and
// (when customStatus is non-nil) the custom status line that came with it.
//
// expiresIn, in seconds (MinCustomStatusExpirySeconds to
// MaxCustomStatusExpirySeconds), makes the line clear itself; it is valid only
// with a non-empty customStatus. A new line without it has no expiry and
// replaces any old one, a bare flip leaves text and expiry alone, and an empty
// line clears both.
//
// The status is stored as chosen, invisible included; collapsing invisible to
// offline is a broadcast-time concern (db.BroadcastStatus), not a storage one —
// the server has to be able to tell "chose to look offline" from "is gone" on
// the next connect. Returns the sanitized custom status the caller should put
// on the wire, so the broadcast and the row can never disagree.
func (s *ChannelService) HandlePresenceUpdate(ctx context.Context, userID int64, status string, customStatus *string, expiresIn *int64, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) (PresenceResult, error) {
	// Rate limit.
	ratKey := auth.Key("presence", userID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 10*time.Second) {
		return PresenceResult{}, ErrRateLimited
	}

	if !db.ValidStatuses[status] {
		return PresenceResult{}, fmt.Errorf("%w: invalid status", ErrBadRequest)
	}
	if expiresIn != nil && (*expiresIn < MinCustomStatusExpirySeconds || *expiresIn > MaxCustomStatusExpirySeconds) {
		return PresenceResult{}, fmt.Errorf("%w: custom_status_expires_in must be %d to %d seconds",
			ErrBadRequest, MinCustomStatusExpirySeconds, MaxCustomStatusExpirySeconds)
	}

	var cleaned *string
	if customStatus != nil {
		// OC-0195: bound the raw bytes before cleanText (sanitizeToFixpoint)
		// runs — see cleanTextBounded's doc comment (user.go). This path is
		// reachable over the WS presence_update frame, whose read limit is
		// config.MaxMessageBytes (1 MiB), far larger than any REST body that
		// reaches the equivalent guard on SetCustomStatus/UpdateProfile.
		text, err := cleanVisibleBounded(*customStatus, MaxCustomStatusLen, "custom_status")
		if err != nil {
			return PresenceResult{}, err
		}
		cleaned = nullable(text)
	}
	if expiresIn != nil && cleaned == nil {
		return PresenceResult{}, fmt.Errorf("%w: custom_status_expires_in needs a non-empty custom_status", ErrBadRequest)
	}
	// A custom status line is the user's own text shown to every member, so
	// a timeout refuses setting one; a plain status change or clearing the
	// line publishes nothing of theirs and stays allowed.
	if cleaned != nil {
		if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
			return PresenceResult{}, err
		}
	}

	if customStatus == nil {
		return s.flipStatus(ctx, userID, status)
	}

	var expiresAt *string
	if expiresIn != nil {
		at := s.now().UTC().Add(time.Duration(*expiresIn) * time.Second).Format(dbtime.ISOLayout)
		expiresAt = &at
	}
	// Status and text commit together in one writer transaction (P5-O08), so
	// a failure leaves both as they were and there is nothing to broadcast.
	if err := s.st.UpdateUserPresence(ctx, userID, status, cleaned, expiresAt); err != nil {
		slog.Error("ChannelService.HandlePresenceUpdate", "err", err, "user_id", userID)
		return PresenceResult{}, fmt.Errorf("%w: failed to update status", ErrInternal)
	}
	s.dropConnectStamp(userID)
	res := PresenceResult{CustomStatus: cleaned}
	if expiresAt != nil {
		res.ExpiresAt = *expiresAt
		if s.wakeExpiry != nil {
			s.wakeExpiry()
		}
	}
	return res, nil
}

// flipStatus is HandlePresenceUpdate's bare status flip (no custom_status
// field): the stored text and expiry ride along on the broadcast, so a plain
// online -> idle flip does not blank everyone else's copy.
func (s *ChannelService) flipStatus(ctx context.Context, userID int64, status string) (PresenceResult, error) {
	// Read it BEFORE writing: custom_status is *string with no omitempty
	// on the wire (see presencePayload), so a nil for a value we merely
	// failed to read would be wire-identical to "the user cleared it", and
	// reading first means a read failure aborts before anything commits.
	current, readErr := s.st.GetUserByID(ctx, userID)
	if readErr != nil || current == nil {
		slog.Error("ChannelService.HandlePresenceUpdate: could not read stored custom status",
			"err", readErr, "user_id", userID)
		return PresenceResult{}, fmt.Errorf("%w: failed to read current custom status", ErrInternal)
	}
	if err := s.st.UpdateUserStatus(ctx, userID, status); err != nil {
		slog.Error("ChannelService.HandlePresenceUpdate", "err", err, "user_id", userID)
		return PresenceResult{}, fmt.Errorf("%w: failed to update status", ErrInternal)
	}
	s.dropConnectStamp(userID)
	res := PresenceResult{CustomStatus: current.CustomStatus}
	if current.CustomStatusExpiresAt != nil {
		res.ExpiresAt = *current.CustomStatusExpiresAt
	}
	return res, nil
}

// dropConnectStamp keeps a pending batched connect stamp from overwriting the
// status a presence_update just committed: the stamp's SQL turns a legacy
// "offline" choice into online.
func (s *ChannelService) dropConnectStamp(userID int64) {
	if s.batch != nil {
		s.batch.dropConnectStamp(userID)
	}
}

// AdmitChannelFocus is channel_focus with read:false: it runs the same
// admission as HandleChannelFocus and returns the channel without writing any
// read state, so a client can focus and subscribe without marking anything read.
func (s *ChannelService) AdmitChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	return admitReadState(ctx, s.st, s.perms, userID, channelID)
}

// HandleChannelFocus processes a channel focus event and updates read state to
// the channel's latest message. Returns the channel for callers to set client
// state.
func (s *ChannelService) HandleChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := admitReadState(ctx, s.st, s.perms, userID, channelID)
	if err != nil {
		return nil, err
	}
	// A forum holds no messages, so it has no read state to keep: focusing it
	// only subscribes the socket (its posts' changes arrive on that topic).
	if ch.Type == db.ForumTypeName {
		return ch, nil
	}
	s.markFocusedRead(ctx, userID, channelID)
	slog.Debug("channel_focus", "user_id", userID, "channel_id", channelID)
	return ch, nil
}

// markFocusedRead marks channelID read at its latest message for userID, the
// write half of channel_focus and thread_focus.
func (s *ChannelService) markFocusedRead(ctx context.Context, userID, channelID int64) {
	// Mark channel as read. latestID == 0 (no undeleted messages) still
	// writes: the upsert is what zeroes mention_count, and a last_read of 0 is
	// correct then — any future message id is larger, so unread counts hold.
	//
	// Skip the UPSERT when the stored row already says exactly this (same
	// last_message_id, no mentions to clear): channel_focus/mark_read fire on
	// every refocus at up to 10/s/user, and even a no-op write occupies the
	// single writer connection and opens a transaction. The extra read runs on
	// the reader pool, which doesn't serialize. Same problem-shape as the
	// session-touch throttle (api/middleware.go).
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err == nil {
		lastRead, mentions, found, rsErr := s.st.GetReadState(ctx, userID, channelID)
		if rsErr == nil && found && lastRead == latestID && mentions == 0 {
			slog.Debug("channel_focus: read state already current, skipping write",
				"user_id", userID, "channel_id", channelID)
			return
		}
	}
	// The write recomputes the watermark itself rather than taking latestID:
	// that snapshot is two round trips old by now, and a mention raised for a
	// newer message in the meantime would be cleared while last_message_id
	// still pointed behind it — a badge that vanishes with nothing to
	// recompute it (OC-0323). latestID is only ever used for the skip
	// decision above, which is a read, not a write — so a failed
	// GetLatestMessageID (or GetReadState) must fall through to this write
	// rather than skip it (OC-0436): the write is the load-bearing half, and
	// only the optimisation above it is allowed to depend on a successful read.
	if wErr := s.st.MarkChannelReadAtLatest(ctx, userID, channelID); wErr != nil {
		// Self-heals on the next focus, but a persistently failing write
		// means unread badges never clear — it must not be invisible.
		slog.Warn("channel_focus: read-state write failed",
			"user_id", userID, "channel_id", channelID, "err", wErr)
	}
}

// admitReadState is the gate every read-state operation shares (channel_focus,
// mark_read, mark_unread): the channel must exist, and the caller must pass
// permissions.CanAdmitSession, which is visibility, the same predicate behind
// ListVisibleChannels, the ready payload and reconnect replay. A socket that
// still holds an id it can no longer see (or an archived channel, OC-0070)
// cannot resubscribe to the live topic or move its read state.
func admitReadState(ctx context.Context, st Store, perms *PermissionService, userID, channelID int64) (*db.Channel, error) {
	ch, err := st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		// A thread is never a socket's focused channel (6.9c): it rides the
		// second slot (thread_focus, AdmitThreadFocus), which a parent's
		// visibility refresh also revokes.
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	sub, subErr := channelSubject(ctx, st, perms, userID, ch, false)
	if subErr != nil {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	if err := permissions.CanAdmitSession(sub); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrForbidden, err)
	}
	return ch, nil
}

// CheckActivityAllowed reports whether userID may publish a game activity
// name (WP 8.3a). The name is text every member sees, so a timeout refuses
// it with ErrTimedOut, like a custom status line; clearing one stays allowed
// and needs no check.
func (s *ChannelService) CheckActivityAllowed(ctx context.Context, userID int64) error {
	return requireNotTimedOut(ctx, s.perms, userID)
}
