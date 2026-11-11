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

type channelStore interface {
	channelCoreStore
	channelOverridesStore
	readFocusStore
}

type channelCoreStore interface {
	db.Auditor
	permissions.DB
	readAdmitStore
	subjectStore
	ListChannels(ctx context.Context) ([]db.Channel, error)
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	UpdateUserPresence(ctx context.Context, userID int64, status string, customStatus, expiresAt *string) error
	UpdateUserStatus(ctx context.Context, id int64, status string) error
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	AdminUpdateChannel(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminDeleteChannel(ctx context.Context, id int64) error
}

type readFocusStore interface {
	// MarkChannelReadAtLatest is the mark-read that computes its own watermark; the send
	// path's read-state advance happens inside CreateMessageWithMentions / CreateMessageDelivery.
	MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
}

type readFocus struct {
	st readFocusStore
}

// ChannelService handles channel listing, permission-filtered access, typing, presence and
// read state. Overrides live on embedded channelOverrides, focus read-state on readFocus.
type ChannelService struct {
	st         channelCoreStore
	afk        AFKStore
	cats       CategoryStore
	forum      ForumStore
	perms      *PermissionService
	batch      *ConnWrites
	wakeExpiry func()
	now        func() time.Time

	*channelOverrides
	*readFocus
}

// NewChannelService creates a ChannelService.
func NewChannelService(st channelStore, perms *PermissionService) *ChannelService {
	// AFK lives on a slice interface because Store is ratcheted (datastore_ratchet_test.go);
	// a Store lacking it makes SetAFKChannel answer ErrInternal.
	afk, _ := st.(AFKStore)
	cats, _ := st.(CategoryStore)
	cperm, _ := st.(CategoryPermStore)
	forum, _ := st.(ForumStore)
	return &ChannelService{
		st:    st,
		afk:   afk,
		cats:  cats,
		forum: forum,
		perms: perms,
		now:   time.Now,
		channelOverrides: &channelOverrides{
			st:    st,
			cats:  cats,
			cperm: cperm,
			perms: perms,
		},
		readFocus: &readFocus{st: st},
	}
}

// SetExpiryWake installs the callback an expiring custom status calls so the expirer re-reads its deadline.
// Call once at startup.
func (s *ChannelService) SetExpiryWake(wake func()) { s.wakeExpiry = wake }

// SetConnWrites installs the batch whose pending connect stamp a committed presence_update drops. Call once
// at startup.
func (s *ChannelService) SetConnWrites(w *ConnWrites) { s.batch = w }

// ListVisibleChannels returns channels the user has ReadMessages for, excluding DMs (DMService).
func (s *ChannelService) ListVisibleChannels(ctx context.Context, userID int64) ([]db.Channel, error) {
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

	// Admins skip the override fetch (they bypass channel checks); others get every held role's override and the
	// per-user layer in one batch.
	grants := permissions.MemberGrants{Perms: role.Perms}
	if !permissions.HasAdmin(role.Perms) {
		grants, err = s.st.GetMemberGrants(ctx, userID)
		if err != nil {
			slog.Error("ChannelService.ListVisibleChannels GetMemberGrants", "err", err, "user_id", userID, "role_ids", role.IDs)
			return nil, fmt.Errorf("%w: failed to fetch channel overrides", ErrInternal)
		}
		grants.Perms = role.Perms
	}

	// Single visibility predicate shared with the ws ready payload and replay, so REST and WS cannot disagree.
	visibleIDs := s.perms.Checker().VisibleChannelIDs(grants, channelRefs(all))
	visible := make([]db.Channel, 0, len(visibleIDs))
	for i := range all {
		if visibleIDs[all[i].ID] {
			visible = append(visible, all[i])
		}
	}
	return visible, nil
}

func channelRefs(channels []db.Channel) []permissions.ChannelRef {
	refs := make([]permissions.ChannelRef, len(channels))
	for i := range channels {
		refs[i] = permissions.ChannelRef{ID: channels[i].ID, Type: channels[i].Type, Archived: channels[i].Archived,
			NSFW: channels[i].NSFW, AuthorityID: channels[i].Thread.ParentID, ThreadLocked: channels[i].Thread.Locked}
	}
	return refs
}

// HandleTyping processes a typing start and returns the channel for broadcast. Best
// effort: errors and refusals return nil silently.
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

	// A forum holds no messages: nothing to type into.
	if ch.Type == db.ForumTypeName {
		return nil, nil
	}

	// A typing indicator announces a post, so it answers to the post policy (CanType is
	// CanSendMessage): read-only members, announcement readers without MANAGE_MESSAGES,
	// archived channels and blocked or non-participant DM users emit nothing.
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if subErr != nil || permissions.CanType(sub) != nil {
		return nil, nil //nolint:nilerr // best-effort: a denial or a DM lookup failure emits nothing
	}

	// Per-user-per-channel rate limit, built only after the channel is known to exist and be
	// readable: earlier, forged channel ids would pin dead entries in the shared
	// RateLimiter, whose Cleanup only evicts a key once every timestamp is stale.
	ratKey := auth.Key(auth.Key("typing", userID), channelID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 3*time.Second) {
		return nil, nil
	}

	return ch, nil
}

// GetDMParticipantIDs returns a DM channel's participant IDs for event builders.
func (s *ChannelService) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	return s.st.GetDMParticipantIDs(ctx, channelID)
}

// PresenceResult is what a committed presence_update leaves on the wire.
type PresenceResult struct {
	CustomStatus *string
	// ExpiresAt is CustomStatus's stored expiry in dbtime.ISOLayout, "" when none; a bare flip carries the
	// stored expiry.
	ExpiresAt string
}

// HandlePresenceUpdate validates and persists a status change and, when customStatus is
// non-nil, its custom status. expiresIn (seconds) makes the line clear itself and needs a
// non-empty customStatus; a new line without it has no expiry, a bare flip leaves text and
// expiry alone, an empty line clears both. The status is stored as chosen, invisible
// included: collapsing to offline is broadcast-time (db.BroadcastStatus) so the next
// connect can tell "chose to look offline" from "is gone". Returns the sanitized custom status.
func (s *ChannelService) HandlePresenceUpdate(ctx context.Context, userID int64, status string, customStatus *string, expiresIn *int64, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) (PresenceResult, error) {
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
		// Bound the raw bytes before cleanText (see cleanTextBounded in user.go); the WS frame
		// read limit is config.MaxMessageBytes (1 MiB), far above any REST body.
		text, err := cleanVisibleBounded(*customStatus, MaxCustomStatusLen, "custom_status")
		if err != nil {
			return PresenceResult{}, err
		}
		cleaned = nullable(text)
	}
	if expiresIn != nil && cleaned == nil {
		return PresenceResult{}, fmt.Errorf("%w: custom_status_expires_in needs a non-empty custom_status", ErrBadRequest)
	}
	// A custom status is the user's own text shown to every member, so a timeout refuses
	// setting one; a plain flip or clearing publishes nothing of theirs.
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
	// Status and text commit in one writer transaction, so a failure leaves both untouched.
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

func (s *ChannelService) flipStatus(ctx context.Context, userID int64, status string) (PresenceResult, error) {
	// Read BEFORE writing: custom_status is *string without omitempty on the wire, so a nil
	// from a failed read would read as "the user cleared it"; reading first aborts before any commit.
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

// dropConnectStamp keeps a pending batched connect stamp from overwriting the status a
// presence_update just committed (the stamp's SQL turns a legacy "offline" into online).
func (s *ChannelService) dropConnectStamp(userID int64) {
	if s.batch != nil {
		s.batch.dropConnectStamp(userID)
	}
}

// AdmitChannelFocus is channel_focus with read:false: the same admission without writing read state.
func (s *ChannelService) AdmitChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	return admitReadState(ctx, s.st, s.perms, userID, channelID)
}

// HandleChannelFocus processes a channel focus, moves read state to the latest message and returns the
// channel.
func (s *ChannelService) HandleChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := admitReadState(ctx, s.st, s.perms, userID, channelID)
	if err != nil {
		return nil, err
	}
	// A forum holds no messages, so no read state: focusing only subscribes the socket.
	if ch.Type == db.ForumTypeName {
		return ch, nil
	}
	s.markFocusedRead(ctx, userID, channelID)
	slog.Debug("channel_focus", "user_id", userID, "channel_id", channelID)
	return ch, nil
}

func (s *readFocus) markFocusedRead(ctx context.Context, userID, channelID int64) {
	// latestID == 0 (no undeleted messages) still writes: the upsert zeroes mention_count and
	// a last_read of 0 is right. Skip the UPSERT when the row already says exactly this:
	// focus/mark_read fire up to 10/s/user and even a no-op write occupies the single writer.
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err == nil {
		lastRead, mentions, found, rsErr := s.st.GetReadState(ctx, userID, channelID)
		if rsErr == nil && found && lastRead == latestID && mentions == 0 {
			slog.Debug("channel_focus: read state already current, skipping write",
				"user_id", userID, "channel_id", channelID)
			return
		}
	}
	// The write recomputes the watermark itself rather than taking the stale latestID: a
	// mention raised for a newer message meanwhile would be cleared while last_message_id
	// pointed behind it. latestID only drives the skip, so a failed read falls through to this write.
	if wErr := s.st.MarkChannelReadAtLatest(ctx, userID, channelID); wErr != nil {
		// Self-heals on the next focus, but a persistently failing write means badges never clear, so it must be
		// visible.
		slog.Warn("channel_focus: read-state write failed",
			"user_id", userID, "channel_id", channelID, "err", wErr)
	}
}

type readAdmitStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// admitReadState is the gate every read-state operation shares (channel_focus, mark_read,
// mark_unread): the channel must exist and pass permissions.CanAdmitSession, so a socket
// holding an id it can no longer see, or an archived channel, cannot resubscribe or move read state.
func admitReadState(ctx context.Context, st readAdmitStore, perms *PermissionService, userID, channelID int64) (*db.Channel, error) {
	ch, err := st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		// A thread is never a socket's focused channel: it rides the second slot (thread_focus,
		// AdmitThreadFocus), which a parent's visibility refresh also revokes.
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

// CheckActivityAllowed reports whether userID may publish a game activity name. Every
// member sees it, so a timeout refuses it (ErrTimedOut); clearing needs no check.
func (s *ChannelService) CheckActivityAllowed(ctx context.Context, userID int64) error {
	return requireNotTimedOut(ctx, s.perms, userID)
}
