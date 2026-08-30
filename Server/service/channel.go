package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ChannelService handles channel-related business logic including
// listing, permission-filtered access, typing, presence, and read state.
type ChannelService struct {
	st    Store
	perms *PermissionService
}

// NewChannelService creates a ChannelService.
func NewChannelService(st Store, perms *PermissionService) *ChannelService {
	return &ChannelService{
		st:    st,
		perms: perms,
	}
}

// ListVisibleChannels returns channels the user has ReadMessages permission for.
// DM channels are excluded (they are accessed via DMService).
func (s *ChannelService) ListVisibleChannels(ctx context.Context, userID int64) ([]db.Channel, error) {
	// Phase B Step 8 — span the public service entrypoint.
	ctx, span := telemetry.GlobalTracer("service/channel").Start(ctx,
		"ChannelService.ListVisibleChannels",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "ListVisibleChannels"))
		span.End()
	}()
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
	// Non-admins get both layers — role and per-user — in one batched fetch.
	var overrides map[int64]db.ChannelOverride
	if !permissions.HasAdmin(role.Permissions) {
		overrides, err = s.st.GetChannelOverridesFor(ctx, role.ID, userID)
		if err != nil {
			// Fail closed — an empty map would return every denied channel.
			slog.Error("ChannelService.ListVisibleChannels GetChannelOverridesFor", "err", err, "user_id", userID, "role_id", role.ID)
			return nil, fmt.Errorf("%w: failed to fetch channel overrides", ErrInternal)
		}
	}

	// Single visibility predicate shared with the ws ready payload and reconnect
	// replay filtering, so REST and WS can never disagree on what a role sees.
	visibleIDs := s.perms.Checker().VisibleChannelIDs(role.Permissions, channelRefs(all), permOverrides(overrides))
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
		refs[i] = permissions.ChannelRef{ID: channels[i].ID, Type: channels[i].Type, Archived: channels[i].Archived}
	}
	return refs
}

// permOverrides maps a db override map to the checker's override map, carrying
// BOTH layers — the role override and the per-user override — so the checker
// resolves the full order (base -> role -> user) rather than half of it.
func permOverrides(overrides map[int64]db.ChannelOverride) map[int64]permissions.ChannelOverride {
	out := make(map[int64]permissions.ChannelOverride, len(overrides))
	for id, o := range overrides {
		out[id] = permissions.ChannelOverride{
			Allow:     o.Allow,
			Deny:      o.Deny,
			UserAllow: o.UserAllow,
			UserDeny:  o.UserDeny,
		}
	}
	return out
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

// HandlePresenceUpdate validates and persists a presence status change, and
// (when customStatus is non-nil) the custom status line that came with it.
//
// The status is stored as chosen, invisible included; collapsing invisible to
// offline is a broadcast-time concern (db.BroadcastStatus), not a storage one —
// the server has to be able to tell "chose to look offline" from "is gone" on
// the next connect. Returns the sanitized custom status the caller should put
// on the wire, so the broadcast and the row can never disagree.
func (s *ChannelService) HandlePresenceUpdate(ctx context.Context, userID int64, status string, customStatus *string, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) (*string, error) {
	// Rate limit.
	ratKey := auth.Key("presence", userID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 10*time.Second) {
		return nil, ErrRateLimited
	}

	if !db.ValidStatuses[status] {
		return nil, fmt.Errorf("%w: invalid status", ErrBadRequest)
	}

	var cleaned *string
	if customStatus != nil {
		// OC-0195: bound the raw bytes before cleanText (sanitizeToFixpoint)
		// runs — see cleanTextBounded's doc comment (user.go). This path is
		// reachable over the WS presence_update frame, whose read limit is
		// config.MaxMessageBytes (1 MiB), far larger than any REST body that
		// reaches the equivalent guard on SetCustomStatus/UpdateProfile.
		text, err := cleanTextBounded(*customStatus, MaxCustomStatusLen, "custom_status")
		if err != nil {
			return nil, err
		}
		cleaned = nullable(text)
	}

	// Read the stored custom status BEFORE either write, unconditionally.
	// custom_status is *string with no omitempty on the wire (see
	// presencePayload), so a nil on the broadcast is wire-identical to "the
	// user cleared it" — returning nil for a value we merely failed to read
	// wipes the text on every connected client while the row still holds it.
	// The stored value is needed twice:
	//   - when the command carries no custom_status field, it is what rides
	//     along on the broadcast (a plain online -> idle flip must not blank
	//     everyone else's copy of the text);
	//   - when it does carry one and the second write below fails after the
	//     status write has already committed, it is the true DB state the
	//     broadcast has to report.
	// Doing it first means a read failure aborts before anything commits,
	// instead of leaving a committed status with nothing truthful to say.
	current, readErr := s.st.GetUserByID(ctx, userID)
	if readErr != nil || current == nil {
		slog.Error("ChannelService.HandlePresenceUpdate: could not read stored custom status",
			"err", readErr, "user_id", userID)
		return nil, fmt.Errorf("%w: failed to read current custom status", ErrInternal)
	}
	storedCustomStatus := current.CustomStatus

	if err := s.st.UpdateUserStatus(ctx, userID, status); err != nil {
		slog.Error("ChannelService.HandlePresenceUpdate", "err", err, "user_id", userID)
		return nil, fmt.Errorf("%w: failed to update status", ErrInternal)
	}

	if customStatus == nil {
		return storedCustomStatus, nil
	}

	if err := s.st.UpdateUserCustomStatus(ctx, userID, cleaned); err != nil {
		// The status row is already committed at this point (two independent
		// writes, no transaction), so failing the whole update here would
		// report total failure — and broadcast nothing — for a presence
		// change that in fact partly succeeded, leaving every client
		// (sender included) stuck on the old status while the DB has the
		// new one. Swallow the write failure and broadcast the value that is
		// actually stored, not the unpersisted "cleaned" text.
		slog.Error("ChannelService.HandlePresenceUpdate custom status", "err", err, "user_id", userID)
		return storedCustomStatus, nil //nolint:nilerr // status committed; broadcast the true stored custom status
	}
	return cleaned, nil
}

// HandleChannelFocus processes a channel focus event and updates read state.
// Returns the channel for callers to set client state.
func (s *ChannelService) HandleChannelFocus(ctx context.Context, userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	// Session admission is permissions.CanAdmitSession — visibility, the same
	// predicate behind ListVisibleChannels, the ready payload and reconnect
	// replay — so a socket that still holds an id it can no longer see (or
	// an archived channel, OC-0070) cannot resubscribe to the live topic or
	// advance its read state. channel_focus and mark_read share this one
	// service call, so the gate closes both at once.
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if subErr != nil {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	if err := permissions.CanAdmitSession(sub); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrForbidden, err)
	}

	// Mark channel as read. latestID == 0 (no undeleted messages) still
	// writes: the upsert is what zeroes mention_count, and a last_read of 0 is
	// correct then — any future message id is larger, so unread counts hold.
	//
	// Skip the UPSERT when the stored row already says exactly this (same
	// last_message_id, no mentions to clear): channel_focus/mark_read fire on
	// every refocus at up to 10/s/user, and even a no-op write occupies the
	// single writer connection and opens a transaction. The extra read runs on
	// the reader pool, which doesn't serialize. Same problem-shape as the
	// session-touch throttle (api/middleware.go). A read failure falls through
	// to the write — the write is the load-bearing half.
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err == nil {
		lastRead, mentions, found, rsErr := s.st.GetReadState(ctx, userID, channelID)
		if rsErr == nil && found && lastRead == latestID && mentions == 0 {
			slog.Debug("channel_focus: read state already current, skipping write",
				"user_id", userID, "channel_id", channelID)
			return ch, nil
		}
		if wErr := s.st.UpdateReadState(ctx, userID, channelID, latestID); wErr != nil {
			// Self-heals on the next focus, but a persistently failing write
			// means unread badges never clear — it must not be invisible.
			slog.Warn("channel_focus: read-state write failed",
				"user_id", userID, "channel_id", channelID, "err", wErr)
		}
	}

	slog.Debug("channel_focus", "user_id", userID, "channel_id", channelID)
	return ch, nil
}
