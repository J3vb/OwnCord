package ws

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// Hub implements service.PermissionChangeNotifier: the services own
// permission-cache invalidation and call these after it, so a caller that is
// not an admin handler gets the same live fan-out. Each method is a thin
// adapter over the hub's existing machinery; none holds a lock of its own.
var _ service.PermissionChangeNotifier = (*Hub)(nil)

// RoleChanged hands a committed role mutation's fan-out to the per-hub role
// refresh worker and returns at once.
func (h *Hub) RoleChanged(f service.RoleFanout) {
	h.EnqueueRoleRefresh(RoleRefresh{
		Visibility:   f.Visibility,
		AllConnected: f.AllConnected,
		MemberUpdate: f.MemberUpdate,
		Roles:        f.Roles,
	})
}

// ChannelAudienceChanged re-derives who can see ch after an override change.
func (h *Hub) ChannelAudienceChanged(ch *db.Channel) {
	h.RefreshChannelVisibility(ch)
}

// RevokeUnreadable releases the topics userID's live client holds that their
// current role cannot read.
func (h *Hub) RevokeUnreadable(userID int64) {
	h.RevokeUnreadableChannels(userID)
}
