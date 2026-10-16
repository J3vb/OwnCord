package permissions_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestIsChannelPrivate(t *testing.T) {
	read := permissions.ReadMessages
	cases := []struct {
		name string
		base int64
		o    permissions.ChannelOverride
		want bool
	}{
		{"override denies read", read | permissions.SendMessages, permissions.ChannelOverride{Deny: read}, true},
		{"override allows read", read, permissions.ChannelOverride{Allow: permissions.SendMessages}, false},
		{"no override, base reads", read, permissions.ChannelOverride{}, false},
		{"base lacks read, no override", permissions.SendMessages, permissions.ChannelOverride{}, true},
		{"override allow beats base deny", permissions.SendMessages, permissions.ChannelOverride{Allow: read}, false},
		{"allow beats deny in one override", read, permissions.ChannelOverride{Allow: read, Deny: read}, false},
		{"administrator is never private", permissions.Administrator, permissions.ChannelOverride{Deny: read}, false},
		{"per-member layer is ignored", read, permissions.ChannelOverride{UserDeny: read}, false},
		{"zero base is private", 0, permissions.ChannelOverride{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := permissions.IsChannelPrivate(tc.base, tc.o); got != tc.want {
				t.Errorf("IsChannelPrivate(%#x, %+v) = %v, want %v", tc.base, tc.o, got, tc.want)
			}
		})
	}
}
