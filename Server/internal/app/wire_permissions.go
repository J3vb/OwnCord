package app

import (
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// wirePermissionNotifiers installs the hub as the PermissionChangeNotifier of
// every service owning a permission-bearing mutation, so every caller (not only
// the admin handlers) reaches live clients.
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
