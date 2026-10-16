package service

import (
	"fmt"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
)

// cleanVisibleBounded is cleanTextBounded for single-line text shown to other
// people (display name, custom status, group DM name). The order is the one the
// REST display-name path established (OC-0197): sanitize and trim first so an
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
