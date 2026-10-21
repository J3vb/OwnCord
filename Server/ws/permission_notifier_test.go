package ws

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/service"
)

// RoleChanged must carry every field of the service's fan-out into the role
// refresh worker's pending state, none dropped or renamed.
func TestHub_RoleChanged_ForwardsEveryField(t *testing.T) {
	h := &Hub{}
	h.RoleChanged(service.RoleFanout{
		Visibility:   []int64{1, 2},
		MemberUpdate: []int64{2, 3},
		AllConnected: true,
		Roles:        true,
	})

	s := &h.roleRefresh
	s.mu.Lock()
	defer s.mu.Unlock()
	if got := s.pending[1]; got != rrVisibility {
		t.Errorf("user 1 flags = %v, want visibility only", got)
	}
	if got := s.pending[2]; got != rrVisibility|rrMember {
		t.Errorf("user 2 flags = %v, want visibility and member", got)
	}
	if got := s.pending[3]; got != rrMember {
		t.Errorf("user 3 flags = %v, want member only", got)
	}
	if !s.all || !s.roles {
		t.Errorf("all = %v, roles = %v, want both set", s.all, s.roles)
	}
}
