package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
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

	// Per-user-per-channel rate limit.
	ratKey := auth.Key(auth.Key("typing", userID), channelID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 3*time.Second) {
		return nil, nil
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, nil //nolint:nilerr // typing indicators are best-effort; errors silently dropped
	}

	if ch.Type == "dm" {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, channelID)
		if dmErr != nil || !ok {
			return nil, nil //nolint:nilerr // typing indicators are best-effort; errors silently dropped
		}
		// A blocked user must not be able to keep poking the blocker with
		// typing indicators. Same gate as the other DM sinks; silently dropped
		// here because typing is best-effort.
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, channelID); blkErr != nil {
			return nil, nil //nolint:nilerr // best-effort: a blocked or unreadable DM emits nothing
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, nil // silent drop
	}

	return ch, nil
}

// GetDMParticipantIDs returns the participant IDs for a DM channel.
// Convenience method for handlers building DM events.
func (s *ChannelService) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	return s.st.GetDMParticipantIDs(ctx, channelID)
}

// HandlePresenceUpdate validates and persists a presence status change.
func (s *ChannelService) HandlePresenceUpdate(ctx context.Context, userID int64, status string, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) error {
	// Rate limit.
	ratKey := auth.Key("presence", userID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 10*time.Second) {
		return ErrRateLimited
	}

	validStatuses := map[string]bool{
		"online": true, "idle": true, "dnd": true, "offline": true,
	}
	if !validStatuses[status] {
		return fmt.Errorf("%w: invalid status", ErrBadRequest)
	}

	if err := s.st.UpdateUserStatus(ctx, userID, status); err != nil {
		slog.Error("ChannelService.HandlePresenceUpdate", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to update status", ErrInternal)
	}

	return nil
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

	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}

	// Mark channel as read.
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err == nil && latestID > 0 {
		_ = s.st.UpdateReadState(ctx, userID, channelID, latestID)
	}

	slog.Debug("channel_focus", "user_id", userID, "channel_id", channelID)
	return ch, nil
}
