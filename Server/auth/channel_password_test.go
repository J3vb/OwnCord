package auth_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestValidateChannelPassword(t *testing.T) {
	cases := []struct {
		name string
		pw   string
		ok   bool
	}{
		{"one character", "a", true},
		{"spaces and symbols", "pass word! 123", true},
		{"64 characters", strings.Repeat("a", 64), true},
		{"empty", "", false},
		{"65 characters", strings.Repeat("a", 65), false},
		{"tab", "a\tb", false},
		{"nul", "a\x00b", false},
		{"del", "a\x7fb", false},
		// 30 three-byte characters are within 64 characters but over bcrypt's 72 bytes.
		{"too many bytes for bcrypt", strings.Repeat("€", 30), false},
	}
	for _, c := range cases {
		err := auth.ValidateChannelPassword(c.pw)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v, want ok=%v", c.name, err, c.ok)
		}
		if err != nil && !errors.Is(err, auth.ErrChannelPasswordInvalid) {
			t.Errorf("%s: err %v does not wrap ErrChannelPasswordInvalid", c.name, err)
		}
	}
}
