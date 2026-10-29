package auth

import "testing"

// The hidden import account is named "[imported]". Registration must not be
// able to take that name, or the importer could not claim it.
func TestValidateUsername_ReservesTheImportAccountName(t *testing.T) {
	for _, name := range []string{"[imported]", "[IMPORTED]", " [imported] ", "[imported-2]"} {
		if err := ValidateUsername(name); err == nil {
			t.Errorf("ValidateUsername(%q) accepted a reserved name", name)
		}
	}
	for _, name := range []string{"imported", "[imported", "my[imported]"} {
		if err := ValidateUsername(name); err != nil {
			t.Errorf("ValidateUsername(%q) = %v, want accepted", name, err)
		}
	}
}
