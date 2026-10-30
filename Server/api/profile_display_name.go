package api

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
)

// validateDisplayName rejects a nickname that would render as something other
// than what it says. Length and emptiness are the service's job (empty clears
// the field); this is the character check (auth.ValidateVisibleText) for the
// same reason auth.ValidateUsername has one — a display name stands in for a
// username on every message row, so a bidi override, a control character or a
// stack of combining marks in one is a spoof or a layout break. The caller has
// already sanitized and collapsed spaces (sanitize, then validate).
func validateDisplayName(name string) error {
	if err := auth.ValidateVisibleText(name); err != nil {
		return fmt.Errorf("display_name %w", err)
	}
	return nil
}
