package service

// Permission-change fan-out port. A permission-bearing mutation invalidates cached permission snapshots and
// then tells live clients (sidebar, held topics, member list, role list); the services own both so a second
// caller (CLI, plugin, WebSocket command) cannot leave stale grants live for the cache TTL. Mirrors
// ModActionNotifier: *ws.Hub implements it through the adapter in ws/permission_notifier.go and service never
// imports ws. A nil notifier is a no-op.

import "github.com/J3vb/OwnCord/Server/db"

// RoleFanout describes the live-client work a committed role mutation needs; its fields mirror
// ws.RoleRefresh.
type RoleFanout struct {
	// Visibility lists users whose held topics, sidebar and affordances are re-derived from their post-change
	// role.
	Visibility []int64
	// AllConnected re-derives that for every connected user; set when the affected member list could not be
	// read.
	AllConnected bool
	// MemberUpdate lists users who get a member_update (a renamed or replaced role regroups them).
	MemberUpdate []int64
	// Roles asks for one roles_update with the role list read at send time.
	Roles bool
}

// PermissionChangeNotifier delivers a committed permission mutation to live clients. Every method is called
// AFTER the permission cache is invalidated: the hub resolves visibility through the same cache, so the
// opposite order would repopulate it from pre-change data.
type PermissionChangeNotifier interface {
	// RoleChanged hands a role mutation's fan-out to the hub's worker and returns at once.
	RoleChanged(f RoleFanout)
	// ChannelAudienceChanged re-derives who can see ch after an override change and sends each client the
	// matching channel_create/channel_delete.
	ChannelAudienceChanged(ch *db.Channel)
	// RevokeUnreadable releases the channel topics userID's live client holds that their current role cannot
	// read.
	RevokeUnreadable(userID int64)
}

// invalidateUsers drops the cached permissions of the given users; a nil PermissionService is a no-op.
func invalidateUsers(perms *PermissionService, userIDs []int64) {
	if perms == nil {
		return
	}
	for _, uid := range userIDs {
		perms.InvalidateUser(uid)
	}
}

// SetPermissionNotifier installs the live fan-out port for channel override changes. Call before serving; nil
// is a no-op.
func (s *channelOverrides) SetPermissionNotifier(n PermissionChangeNotifier) { s.notifier = n }

// applyOverrideEffects runs an override mutation's post-commit work: cache invalidation narrowed to who can
// be affected (full flush as the fail-safe, since a missed eviction is a stale grant), THEN the audience
// refresh.
func (s *channelOverrides) applyOverrideEffects(res OverrideResult, ch *db.Channel) {
	if s.perms != nil {
		if res.AffectedAll {
			s.perms.InvalidateAll()
		} else {
			invalidateUsers(s.perms, res.AffectedUsers)
		}
	}
	if s.notifier != nil {
		s.notifier.ChannelAudienceChanged(ch)
	}
}

// invalidatePermEffect drops the cached permissions a PermEffect names: the listed users, or every mask when
// the narrow list could not be read.
func (s *channelOverrides) invalidatePermEffect(e PermEffect) {
	if s.perms == nil {
		return
	}
	if e.AffectedAll {
		s.perms.InvalidateAll()
		return
	}
	invalidateUsers(s.perms, e.AffectedUsers)
}

// notifyAudience re-derives who can see ch. Callers invalidate first.
func (s *channelOverrides) notifyAudience(ch *db.Channel) {
	if s.notifier != nil {
		s.notifier.ChannelAudienceChanged(ch)
	}
}

func (s *channelOverrides) notifyAudienceIf(applied bool, ch *db.Channel) {
	if applied {
		s.notifyAudience(ch)
	}
}

// SetPermissionNotifier installs the live fan-out port for role assignment, apart from SetNotifier. Call
// before serving.
func (s *ModerationService) SetPermissionNotifier(n PermissionChangeNotifier) {
	s.permNotifier = n
}

// roleAssigned fans a committed role assignment out to the target's live clients: unreadable held channels
// are released before it returns, then the worker re-derives the sidebar and announces the role name.
func (s *ModerationService) roleAssigned(targetID int64) {
	if s.permNotifier == nil {
		return
	}
	s.permNotifier.RevokeUnreadable(targetID)
	s.permNotifier.RoleChanged(RoleFanout{Visibility: []int64{targetID}, MemberUpdate: []int64{targetID}})
}
