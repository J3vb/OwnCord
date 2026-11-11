package service

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// Bounds for numeric channel settings: SQLite would store a slow mode of six years or a
// user limit of -3. Values match what clients offer (0 = unlimited in both voice cases).
const (
	maxSlowModeSeconds = 21600
	maxVoiceLimit      = 99
)

func nsfwAuditSuffix(before, after bool) string {
	if before == after {
		return ""
	}
	if after {
		return " (marked NSFW)"
	}
	return " (unmarked NSFW)"
}

// channelPasswordChange validates a requested password change and hashes it. A nil
// request, or removing a password the channel lacks, changes nothing (nil).
func channelPasswordChange(existing *db.Channel, requested *string) (*db.ChannelPasswordChange, error) {
	if requested == nil {
		return nil, nil
	}
	if existing.Type != "voice" {
		return nil, fmt.Errorf("a password can only be set on a voice channel%.0w", ErrBadRequest)
	}
	if *requested == "" {
		if !existing.JoinLocked {
			return nil, nil
		}
		return &db.ChannelPasswordChange{Clear: true}, nil
	}
	if err := auth.ValidateChannelPassword(*requested); err != nil {
		return nil, fmt.Errorf("%s%.0w", err.Error(), ErrBadRequest)
	}
	hash, err := auth.HashPassword(*requested)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to hash channel password: %w", ErrInternal, err)
	}
	return &db.ChannelPasswordChange{Hash: hash}, nil
}

func passwordAuditSuffix(wasProtected bool, change *db.ChannelPasswordChange) string {
	switch {
	case change == nil:
		return ""
	case change.Clear:
		return " (password removed)"
	case wasProtected:
		return " (password changed)"
	}
	return " (password set)"
}

func validateChannelUpdate(existing *db.Channel, req AdminChannelUpdate) (*db.ChannelPasswordChange, error) {
	if err := validateChannelBounds(req); err != nil {
		return nil, err
	}
	return channelPasswordChange(existing, req.Password)
}

func validateChannelBounds(req AdminChannelUpdate) error {
	switch {
	case req.SlowMode < 0 || req.SlowMode > maxSlowModeSeconds:
		return fmt.Errorf("slow_mode must be between 0 and %d seconds%.0w", maxSlowModeSeconds, ErrBadRequest)
	case req.VoiceMaxUsers < 0 || req.VoiceMaxUsers > maxVoiceLimit:
		return fmt.Errorf("voice_max_users must be between 0 and %d%.0w", maxVoiceLimit, ErrBadRequest)
	case req.VoiceMaxVideo < 0 || req.VoiceMaxVideo > maxVoiceLimit:
		return fmt.Errorf("voice_max_video must be between 0 and %d%.0w", maxVoiceLimit, ErrBadRequest)
	}
	return nil
}
