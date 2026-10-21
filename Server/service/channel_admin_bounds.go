package service

import "fmt"

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
