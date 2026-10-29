package service

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
)

// cleanVisibleBounded is cleanTextBounded for single-line text shown to other
// people (display name, custom status, group DM name). The order is the one the
// REST display-name path established: sanitize and trim first so an
// HTML-entity-encoded control or bidi character is the real character by the
// time it is checked, then collapse runs of spaces, then check the characters,
// and only then count runes, so the cap applies to what is stored.
func cleanVisibleBounded(v string, maxRunes int, fieldName string) (string, error) {
	if len(v) > maxRunes*4 {
		return "", fmt.Errorf("%w: %s must be at most %d characters", ErrBadRequest, fieldName, maxRunes)
	}
	collapsed := auth.CollapseSpaces(cleanText(v))
	if err := auth.ValidateVisibleText(collapsed); err != nil {
		return "", fmt.Errorf("%w: %s %w", ErrBadRequest, fieldName, err)
	}
	if utf8.RuneCountInString(collapsed) > maxRunes {
		return "", fmt.Errorf("%w: %s must be at most %d characters", ErrBadRequest, fieldName, maxRunes)
	}
	return collapsed, nil
}

// MaxActivityNameLen bounds a game activity's name: one line under a
// member's name, the same cap as a custom status.
const MaxActivityNameLen = 128

// CleanActivityName is the activity_update name rule: trimmed, then exactly
// the custom status text rules (cleanVisibleBounded). A name that is empty
// after the trim returns "" with no error, which the caller reads as "clear".
// Too long or not single-line visible text wraps ErrBadRequest.
func CleanActivityName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	return cleanVisibleBounded(trimmed, MaxActivityNameLen, "activity name")
}

// Listening activity text caps: title and artist share the game
// name's cap, the player (the app's name) is shorter.
const (
	MaxListeningTitleLen  = MaxActivityNameLen
	MaxListeningArtistLen = MaxActivityNameLen
	MaxListeningPlayerLen = 64
)

// CleanListeningText is CleanActivityName with the cap and the field name of a
// listening_update text (title, artist or player): trimmed, then the custom
// status text rules. Empty after the trim returns "" with no error; the caller
// decides whether that means "clear", "no artist" or BAD_REQUEST.
func CleanListeningText(raw string, maxRunes int, fieldName string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	return cleanVisibleBounded(trimmed, maxRunes, fieldName)
}
