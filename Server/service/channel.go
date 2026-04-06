package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// ChannelService handles channel-related business logic including
// listing, permission-filtered access, typing, presence, and read state.
type ChannelService struct {
	st    store.Store
	perms *PermissionService
}

// NewChannelService creates a ChannelService.
func NewChannelService(st store.Store, perms *PermissionService) *ChannelService {
	return &ChannelService{
		st:    st,
		perms: perms,
	}
}

// ListVisibleChannels returns channels the user has ReadMessages permission for.
// DM channels are excluded (they are accessed via DMService).
func (s *ChannelService) ListVisibleChannels(userID int64) ([]db.Channel, error) {
	// Phase B Step 8 — span the public service entrypoint.
	ctx, span := telemetry.GlobalTracer("service/channel").Start(context.Background(),
		"ChannelService.ListVisibleChannels",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "ListVisibleChannels"))
		span.End()
	}()
	all, err := s.st.ListChannels()
	if err != nil {
		slog.Error("ChannelService.ListVisibleChannels", "err", err)
		return nil, fmt.Errorf("%w: failed to list channels", ErrInternal)
	}

	role, err := s.perms.GetRoleForUser(userID)
	if err != nil || role == nil {
		slog.Error("ChannelService.ListVisibleChannels GetRoleForUser", "err", err, "user_id", userID)
		return nil, fmt.Errorf("%w: failed to get role", ErrInternal)
	}

	isAdmin := permissions.HasAdmin(role.Permissions)
	if isAdmin {
		// Admin sees all non-DM channels.
		var visible []db.Channel
		for _, ch := range all {
			if ch.Type != "dm" {
				visible = append(visible, ch)
			}
		}
		return visible, nil
	}

	overrides, err := s.st.GetAllChannelPermissionsForRole(role.ID)
	if err != nil {
		overrides = make(map[int64]db.ChannelOverride)
	}

	var visible []db.Channel
	for _, ch := range all {
		if ch.Type == "dm" {
			continue
		}
		o := overrides[ch.ID]
		effective := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
		if effective&permissions.ReadMessages == permissions.ReadMessages {
			visible = append(visible, ch)
		}
	}

	if visible == nil {
		visible = []db.Channel{}
	}
	return visible, nil
}

// HandleTyping processes a typing start event for a channel.
// Returns the channel so callers can build broadcast events.
// Silent errors are returned as nil (typing indicators are best-effort).
func (s *ChannelService) HandleTyping(userID, channelID int64, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, nil
	}

	// Per-user-per-channel rate limit.
	ratKey := fmt.Sprintf("typing:%d:%d", userID, channelID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 3*time.Second) {
		return nil, nil
	}

	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return nil, nil // silent drop
	}

	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil || !ok {
			return nil, nil // silent drop
		}
	} else if !s.perms.HasChannelPerm(userID, channelID, permissions.ReadMessages) {
		return nil, nil // silent drop
	}

	return ch, nil
}

// GetDMParticipantIDs returns the participant IDs for a DM channel.
// Convenience method for handlers building DM events.
func (s *ChannelService) GetDMParticipantIDs(channelID int64) ([]int64, error) {
	return s.st.GetDMParticipantIDs(channelID)
}

// HandlePresenceUpdate validates and persists a presence status change.
func (s *ChannelService) HandlePresenceUpdate(userID int64, status string, limiter interface {
	Allow(key string, limit int, window time.Duration) bool
},
) error {
	// Rate limit.
	ratKey := fmt.Sprintf("presence:%d", userID)
	if limiter != nil && !limiter.Allow(ratKey, 1, 10*time.Second) {
		return ErrRateLimited
	}

	validStatuses := map[string]bool{
		"online": true, "idle": true, "dnd": true, "offline": true,
	}
	if !validStatuses[status] {
		return fmt.Errorf("%w: invalid status", ErrBadRequest)
	}

	if err := s.st.UpdateUserStatus(userID, status); err != nil {
		slog.Error("ChannelService.HandlePresenceUpdate", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to update status", ErrInternal)
	}

	return nil
}

// HandleChannelFocus processes a channel focus event and updates read state.
// Returns the channel for callers to set client state.
func (s *ChannelService) HandleChannelFocus(userID, channelID int64) (*db.Channel, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
	} else {
		if !s.perms.HasChannelPerm(userID, channelID, permissions.ReadMessages) {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
	}

	// Mark channel as read.
	latestID, err := s.st.GetLatestMessageID(channelID)
	if err == nil && latestID > 0 {
		_ = s.st.UpdateReadState(userID, channelID, latestID)
	}

	slog.Debug("channel_focus", "user_id", userID, "channel_id", channelID)
	return ch, nil
}
