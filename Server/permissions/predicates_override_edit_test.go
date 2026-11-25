package permissions

import (
	"errors"
	"testing"
)

func TestCanEditChannelOverrides(t *testing.T) {
	t.Parallel()
	const manager = ManageChannels | ReadMessages
	cases := []struct {
		name   string
		s      Subject
		roleID int64
		pos    int
		want   error
	}{
		{"reader may edit", Subject{RolePerms: manager, Channel: text(false)}, 21, 50, nil},
		{"archived but readable may edit", Subject{RolePerms: manager, Channel: text(true)}, 21, 50, nil},
		{"role deny refuses", Subject{RolePerms: manager, Override: deny(ReadMessages), Channel: text(false)}, 21, 50, ErrPermissionDenied},
		{"user deny refuses", Subject{RolePerms: manager, Override: userDeny(ReadMessages), Channel: text(false)}, 21, 50, ErrPermissionDenied},
		{"administrator despite deny", Subject{RolePerms: Administrator, Override: deny(ReadMessages), Channel: text(false)}, 21, 50, nil},
		{"owner despite deny", Subject{RolePerms: ManageChannels, Override: deny(ReadMessages), Channel: text(false)}, OwnerRoleID, 50, nil},
		{"zero subject refuses", Subject{}, 21, 50, ErrPermissionDenied},
		{"dm participant may edit without role bits", Subject{Channel: dm(), DMParticipant: true}, 21, 50, nil},
		{"dm non-participant refused despite role bits", Subject{RolePerms: manager, Channel: dm()}, 21, 50, ErrNotDMParticipant},
	}
	for _, tc := range cases {
		err := CanEditChannelOverrides(tc.s, tc.roleID, tc.pos)
		if tc.want == nil && err != nil {
			t.Errorf("%s: err = %v, want nil", tc.name, err)
		}
		if tc.want != nil && !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
}
