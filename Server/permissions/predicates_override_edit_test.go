package permissions

import "testing"

func TestCanEditChannelOverrides(t *testing.T) {
	t.Parallel()
	const manager = ManageChannels | ReadMessages
	cases := []struct {
		name    string
		s       Subject
		roleID  int64
		pos     int
		wantErr bool
	}{
		{"reader may edit", Subject{RolePerms: manager, Channel: text(false)}, 21, 50, false},
		{"archived but readable may edit", Subject{RolePerms: manager, Channel: text(true)}, 21, 50, false},
		{"role deny refuses", Subject{RolePerms: manager, Override: deny(ReadMessages), Channel: text(false)}, 21, 50, true},
		{"user deny refuses", Subject{RolePerms: manager, Override: userDeny(ReadMessages), Channel: text(false)}, 21, 50, true},
		{"administrator despite deny", Subject{RolePerms: Administrator, Override: deny(ReadMessages), Channel: text(false)}, 21, 50, false},
		{"owner despite deny", Subject{RolePerms: ManageChannels, Override: deny(ReadMessages), Channel: text(false)}, OwnerRoleID, 50, false},
		{"zero subject refuses", Subject{}, 21, 50, true},
	}
	for _, tc := range cases {
		err := CanEditChannelOverrides(tc.s, tc.roleID, tc.pos)
		if (err != nil) != tc.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", tc.name, err, tc.wantErr)
		}
	}
}
