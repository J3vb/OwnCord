package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// VoiceService handles voice state business logic.
type VoiceService struct {
	st   store.Store
	perm *PermissionService
}

// NewVoiceService creates a VoiceService.
func NewVoiceService(st store.Store, perm *PermissionService) *VoiceService {
	return &VoiceService{st: st, perm: perm}
}

// JoinChannel validates the channel, checks ConnectVoice permission, and
// joins the user to the voice channel respecting capacity limits.
// Returns the channel on success so callers can access voice config fields.
func (s *VoiceService) JoinChannel(userID, channelID int64) (*db.Channel, error) {
	ctx, span := telemetry.GlobalTracer("service/voice").Start(context.Background(), "VoiceService.JoinChannel",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("channel_id", channelID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationMs, start,
			telemetry.String("method", "JoinChannel"))
		span.End()
	}()

	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	if !s.perm.HasChannelPerm(userID, channelID, permissions.ConnectVoice) {
		return nil, fmt.Errorf("%w: missing CONNECT_VOICE permission", ErrForbidden)
	}

	maxUsers := ch.VoiceMaxUsers
	if maxUsers > 0 {
		if err := s.st.JoinVoiceChannelIfCapacity(userID, channelID, maxUsers); err != nil {
			if errors.Is(err, db.ErrChannelFull) {
				return nil, fmt.Errorf("%w: voice channel is full", ErrForbidden)
			}
			slog.Error("VoiceService.JoinChannel JoinVoiceChannelIfCapacity", "err", err, "user_id", userID)
			return nil, fmt.Errorf("%w: failed to join voice channel", ErrInternal)
		}
	} else {
		if err := s.st.JoinVoiceChannel(userID, channelID); err != nil {
			slog.Error("VoiceService.JoinChannel JoinVoiceChannel", "err", err, "user_id", userID)
			return nil, fmt.Errorf("%w: failed to join voice channel", ErrInternal)
		}
	}

	slog.Info("voice join", "user_id", userID, "channel_id", channelID)
	return ch, nil
}

// LeaveChannel removes the user from their current voice channel.
func (s *VoiceService) LeaveChannel(userID int64) error {
	if err := s.st.LeaveVoiceChannel(userID); err != nil {
		slog.Error("VoiceService.LeaveChannel", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to leave voice channel", ErrInternal)
	}

	slog.Info("voice leave", "user_id", userID)
	return nil
}

// UpdateMute toggles the mute state for the given user.
func (s *VoiceService) UpdateMute(userID int64, muted bool) error {
	if err := s.st.UpdateVoiceMute(userID, muted); err != nil {
		slog.Error("VoiceService.UpdateMute", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to update mute state", ErrInternal)
	}

	slog.Debug("voice mute changed", "user_id", userID, "muted", muted)
	return nil
}

// UpdateDeafen toggles the deafen state for the given user.
func (s *VoiceService) UpdateDeafen(userID int64, deafened bool) error {
	if err := s.st.UpdateVoiceDeafen(userID, deafened); err != nil {
		slog.Error("VoiceService.UpdateDeafen", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to update deafen state", ErrInternal)
	}

	slog.Debug("voice deafen changed", "user_id", userID, "deafened", deafened)
	return nil
}

// ToggleCamera enables or disables the user's camera. When enabling, it
// enforces the maxVideo limit via an atomic check-and-update. Returns true
// if the camera was successfully enabled (or disabled), false if the video
// limit was reached.
func (s *VoiceService) ToggleCamera(userID, channelID int64, enable bool, maxVideo int) (bool, error) {
	if !s.perm.HasChannelPerm(userID, channelID, permissions.UseVideo) {
		return false, fmt.Errorf("%w: missing USE_VIDEO permission", ErrForbidden)
	}

	if enable && maxVideo > 0 {
		ok, err := s.st.EnableCameraIfUnderLimit(userID, channelID, maxVideo)
		if err != nil {
			slog.Error("VoiceService.ToggleCamera EnableCameraIfUnderLimit", "err", err, "user_id", userID)
			return false, fmt.Errorf("%w: failed to check video limit", ErrInternal)
		}
		if !ok {
			return false, nil
		}
	} else {
		if err := s.st.UpdateVoiceCamera(userID, enable); err != nil {
			slog.Error("VoiceService.ToggleCamera UpdateVoiceCamera", "err", err, "user_id", userID)
			return false, fmt.Errorf("%w: failed to update camera state", ErrInternal)
		}
	}

	slog.Debug("voice camera changed", "user_id", userID, "enabled", enable, "channel_id", channelID)
	return true, nil
}

// ToggleScreenshare enables or disables the user's screen share after
// checking the ShareScreen permission.
func (s *VoiceService) ToggleScreenshare(userID, channelID int64, enable bool) error {
	if !s.perm.HasChannelPerm(userID, channelID, permissions.ShareScreen) {
		return fmt.Errorf("%w: missing SHARE_SCREEN permission", ErrForbidden)
	}

	if err := s.st.UpdateVoiceScreenshare(userID, enable); err != nil {
		slog.Error("VoiceService.ToggleScreenshare", "err", err, "user_id", userID)
		return fmt.Errorf("%w: failed to update screenshare state", ErrInternal)
	}

	slog.Debug("voice screenshare changed", "user_id", userID, "enabled", enable, "channel_id", channelID)
	return nil
}
