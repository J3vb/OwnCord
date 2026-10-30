package service

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// Bounds for the numeric channel settings an update may set: SQLite would
// happily store a slow mode of six years or a user limit of -3, and the only
// place that would surface is a client rendering nonsense. The values match
// what the clients offer (0 = unlimited in both voice cases).
const (
	maxSlowModeSeconds = 21600
	maxVoiceLimit      = 99
)

// nsfwAuditSuffix names an NSFW transition in the audit detail, or returns ""
// when the flag did not move — the one part of a channel edit an operator may
// need to answer for later.
func nsfwAuditSuffix(before, after bool) string {
	if before == after {
		return ""
	}
	if after {
		return " (marked NSFW)"
	}
	return " (unmarked NSFW)"
}

// channelPasswordChange validates a requested password change and hashes the
// new password. A nil request, or removing a password the channel does not
// have, changes nothing (nil result).
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

// passwordAuditSuffix words a password change for the audit detail. It names
// the kind of change only, never the password or its hash.
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

// validateChannelUpdate runs the checks that need no database read: the
// numeric bounds and the requested password change. It returns the password
// change to write, hashed.
func validateChannelUpdate(existing *db.Channel, req AdminChannelUpdate) (*db.ChannelPasswordChange, error) {
	if err := validateChannelBounds(req); err != nil {
		return nil, err
	}
	return channelPasswordChange(existing, req.Password)
}

// validateChannelBounds checks the numeric settings of an update.
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
