package app

import (
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// wirePermissionNotifiers installs the hub as the PermissionChangeNotifier of
// every service that owns a permission-bearing mutation. The role,
// channel-override and role-assignment services invalidate the permission cache
// themselves and then fan out through this port, so every caller of those
// methods (not only the admin handlers) reaches live clients. Call it before
// the server starts serving, next to the other hub notifiers in wireAuth, so
// no mutation races the install. A nil service is skipped.
func wirePermissionNotifiers(svc *service.Services, hub *ws.Hub) {
	if svc.Roles != nil {
		svc.Roles.SetPermissionNotifier(hub)
	}
	if svc.Channels != nil {
		svc.Channels.SetPermissionNotifier(hub)
	}
	if svc.Moderation != nil {
		svc.Moderation.SetPermissionNotifier(hub)
	}
}
