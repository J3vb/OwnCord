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

// channelStore is what ChannelService reads and writes. *db.DB satisfies it.
type channelStore interface {
	db.Auditor
	permissions.DB
	readAdmitStore
	subjectStore
	// MarkChannelReadAtLatest is the mark-read that computes its own watermark. The
	// send path's read-state advance happens inside CreateMessageWithMentions /
	// CreateMessageDelivery.
	MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
	ListChannels(ctx context.Context) ([]db.Channel, error)
	// Override CRUD for the channel permission layer: the listings the matrix editor
	// renders and the gated writes/clears.
	ListChannelRoleOverrides(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, error)
	ListChannelUserOverrides(ctx context.Context, channelID int64) ([]db.ChannelUserOverride, error)
	UpsertChannelOverride(ctx context.Context, channelID, roleID, allow, deny int64) error
	DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error
	UpsertChannelUserOverride(ctx context.Context, channelID, userID, allow, deny int64) error
	DeleteChannelUserOverride(ctx context.Context, channelID, userID int64) error
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	UpdateUserPresence(ctx context.Context, userID int64, status string, customStatus, expiresAt *string) error
	UpdateUserStatus(ctx context.Context, id int64, status string) error
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	AdminUpdateChannel(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminDeleteChannel(ctx context.Context, id int64) error
}

// ChannelService handles channel listing, permission-filtered access, typing,
// presence and read state.
type ChannelService struct {
	st    channelStore
	afk   AFKStore
	cats  CategoryStore
	cperm CategoryPermStore
	forum ForumStore
	perms *PermissionService
	batch *ConnWrites
	// notifier re-derives channel audiences after an override change; nil is a no-op.
	notifier PermissionChangeNotifier
	// wakeExpiry nudges the custom status expirer after an expiring status commits.
	wakeExpiry func()
	now        func() time.Time
}

// NewChannelService creates a ChannelService.
func NewChannelService(st channelStore, perms *PermissionService) *ChannelService {
	// AFK lives on a slice interface because Store is ratcheted
	// (datastore_ratchet_test.go); a Store lacking it makes SetAFKChannel answer
	// ErrInternal.
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

// SetExpiryWake installs the callback an expiring custom status calls so the
// expirer re-reads its deadline. Call once at startup.
func (s *ChannelService) SetExpiryWake(wake func()) { s.wakeExpiry = wake }

// SetConnWrites installs the batch whose pending connect stamp a committed
// presence_update drops. Call once at startup.
func (s *ChannelService) SetConnWrites(w *ConnWrites) { s.batch = w }

// ListVisibleChannels returns channels the user has ReadMessages permission for,
// excluding DMs (DMService).
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

	// Admins skip the override fetch (they bypass all channel checks); others get
	// every held role's override and the per-user layer in one batch.
	grants := permissions.MemberGrants{Perms: role.Perms}
	if !permissions.HasAdmin(role.Perms) {
		grants, err = s.st.GetMemberGrants(ctx, userID)
		if err != nil {
			// Fail closed: an empty map would return every denied channel.
			slog.Error("ChannelService.ListVisibleChannels GetMemberGrants", "err", err, "user_id", userID, "role_ids", role.IDs)
			return nil, fmt.Errorf("%w: failed to fetch channel overrides", ErrInternal)
		}
		grants.Perms = role.Perms
	}

	// Single visibility predicate shared with the ws ready payload and reconnect
	// replay filtering, so REST and WS cannot disagree.
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

// HandleTyping processes a typing start for a channel and returns it for the
// broadcast. Typing is best-effort: errors and refusals return nil silently.
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

	// A forum holds no messages: nothing to type into, silent like every typing refusal.
	if ch.Type == db.ForumTypeName {
		return nil, nil
	}

	// A typing indicator announces a post, so it answers to the post policy
	// (permissions.CanType is CanSendMessage): read-only members, announcement
	// readers without MANAGE_MESSAGES, archived channels and blocked or
	// non-participant DM users emit nothing.
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if subErr != nil || permissions.CanType(sub) != nil {
		return nil, nil //nolint:nilerr // best-effort: a denial or a DM lookup failure emits nothing
	}

	// Per-user-per-channel rate limit, built only after the channel is known to exist
	// and be readable: doing it earlier let forged channel ids pin dead entries in
	// the shared RateLimiter, whose Cleanup only evicts a key once every timestamp is
	// stale, retaining an unbounded number for hours.
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
	// CustomStatus is the sanitized line to publish (nil = none).
	CustomStatus *string
	// ExpiresAt is CustomStatus's stored expiry in dbtime.ISOLayout, "" when none; a
	// bare status flip carries the expiry stored with its text.
	ExpiresAt string
}

// HandlePresenceUpdate validates and persists a status change and, when
// customStatus is non-nil, its custom status line. expiresIn (seconds,
// MinCustomStatusExpirySeconds..MaxCustomStatusExpirySeconds) makes the line
// clear itself and needs a non-empty customStatus; a new line without it has no
// expiry and replaces any old one, a bare flip leaves text and expiry alone, an
// empty line clears both. The status is stored as chosen, invisible included:
// collapsing it to offline is broadcast-time (db.BroadcastStatus), because the
// next connect must tell "chose to look offline" from "is gone". Returns the
// sanitized custom status for the wire, so broadcast and row cannot disagree.
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
		// Bound the raw bytes before cleanText; see cleanTextBounded (user.go). The WS
		// presence_update frame's read limit is config.MaxMessageBytes (1 MiB), far above
		// any REST body reaching the equivalent guard.
		text, err := cleanVisibleBounded(*customStatus, MaxCustomStatusLen, "custom_status")
		if err != nil {
			return PresenceResult{}, err
		}
		cleaned = nullable(text)
	}
	if expiresIn != nil && cleaned == nil {
		return PresenceResult{}, fmt.Errorf("%w: custom_status_expires_in needs a non-empty custom_status", ErrBadRequest)
	}
	// A custom status is the user's own text shown to every member, so a timeout
	// refuses setting one; a plain flip or clearing publishes nothing of theirs.
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
	// Status and text commit together in one writer transaction, so a failure leaves
	// both as they were and nothing to broadcast.
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

// flipStatus is the bare status flip (no custom_status): the stored text and
// expiry ride along on the broadcast so an online-to-idle flip does not blank
// others' copy.
func (s *ChannelService) flipStatus(ctx context.Context, userID int64, status string) (PresenceResult, error) {
	// Read BEFORE writing: custom_status is *string without omitempty on the wire
	// (presencePayload), so a nil from a failed read would read as "the user cleared
	// it", and reading first aborts before anything commits.
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
// status a presence_update just committed (the stamp's SQL turns a legacy
// "offline" into online).
func (s *ChannelService) dropConnectStamp(userID int64) {
	if s.batch != nil {
		s.batch.dropConnectStamp(userID)
	}
}

// AdmitChannelFocus is channel_focus with read:false: the same admission as
// HandleChannelFocus without writing read state.
func (s *ChannelService) AdmitChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	return admitReadState(ctx, s.st, s.perms, userID, channelID)
}

// HandleChannelFocus processes a channel focus and moves read state to the latest
// message, returning the channel.
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

// markFocusedRead marks channelID read at its latest message (the write half of
// channel_focus and thread_focus).
func (s *ChannelService) markFocusedRead(ctx context.Context, userID, channelID int64) {
	// latestID == 0 (no undeleted messages) still writes: the upsert zeroes
	// mention_count and a last_read of 0 is right since any future id is larger.
	// Skip the UPSERT when the stored row already says exactly this (same
	// last_message_id, no mentions): focus/mark_read fire up to 10/s/user and even a
	// no-op write occupies the single writer. The extra read runs on the reader pool
	// (same shape as the session-touch throttle, api/middleware.go).
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err == nil {
		lastRead, mentions, found, rsErr := s.st.GetReadState(ctx, userID, channelID)
		if rsErr == nil && found && lastRead == latestID && mentions == 0 {
			slog.Debug("channel_focus: read state already current, skipping write",
				"user_id", userID, "channel_id", channelID)
			return
		}
	}
	// The write recomputes the watermark itself rather than taking latestID, which is
	// two round trips stale: a mention raised for a newer message meanwhile would be
	// cleared while last_message_id pointed behind it, a badge that vanishes. latestID
	// only drives the skip decision, so a failed read must fall through to this
	// write; only the optimisation may depend on a successful read.
	if wErr := s.st.MarkChannelReadAtLatest(ctx, userID, channelID); wErr != nil {
		// Self-heals on the next focus, but a persistently failing write means badges
		// never clear, so it must be visible.
		slog.Warn("channel_focus: read-state write failed",
			"user_id", userID, "channel_id", channelID, "err", wErr)
	}
}

// readAdmitStore is what admitReadState and admitReadPointer read.
type readAdmitStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// admitReadState is the gate every read-state operation shares (channel_focus,
// mark_read, mark_unread): the channel must exist and the caller must pass
// permissions.CanAdmitSession (visibility, the predicate behind
// ListVisibleChannels, ready and replay), so a socket holding an id it can no
// longer see, or an archived channel, cannot resubscribe or move read state.
func admitReadState(ctx context.Context, st readAdmitStore, perms *PermissionService, userID, channelID int64) (*db.Channel, error) {
	ch, err := st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		// A thread is never a socket's focused channel: it rides the second slot
		// (thread_focus, AdmitThreadFocus), which a parent's visibility refresh also revokes.
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

// CheckActivityAllowed reports whether userID may publish a game activity name.
// Every member sees it, so a timeout refuses it (ErrTimedOut) like a custom
// status; clearing needs no check.
func (s *ChannelService) CheckActivityAllowed(ctx context.Context, userID int64) error {
	return requireNotTimedOut(ctx, s.perms, userID)
}
