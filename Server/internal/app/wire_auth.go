package app

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
)

// wireAuth runs inside StartRuntime before the hub's dispatch goroutine starts,
// so no setter runs after Run.
func wireAuth(svc *service.Services, authSvc *service.AuthService, store *storage.Storage, hub *ws.Hub) {
	svc.Auth = authSvc
	if store != nil {
		if svc.Erasure != nil {
			svc.Erasure.SetFiles(store)
		}
		if svc.Retention != nil {
			svc.Retention.SetFiles(store)
		}
		if svc.Uploads != nil {
			svc.Uploads.SetFileCloner(store) // forwarded files
		}
	}
	if hub != nil {
		if svc.Erasure != nil {
			svc.Erasure.SetHub(hub)
		}
		if svc.Retention != nil {
			svc.Retention.SetHub(hub)
		}
		wirePermissionNotifiers(svc, hub)
		if svc.Moderation != nil {
			svc.Moderation.SetNotifier(hub)
			svc.Moderation.SetVoiceMuter(hub)
		}
		if svc.Appeals != nil {
			// A live appellant gets appeal_status frames. The mod_queue
			// broadcaster is wired too, so Assign/Decide/Withdraw issue both
			// frames under the same per-appeal lock.
			svc.Appeals.SetNotifier(hub)
			svc.Appeals.SetQueueBroadcaster(hub)
			// An overturned ban must re-add the member to every connected
			// roster, as the admin unban path does.
			svc.Appeals.SetUnbanBroadcaster(hub)
		}
	}
	authSvc.UseWelcome(svc.Welcome)
	if hub != nil {
		svc.Welcome.SetNotifier(hub)
	}
	// A missing svc.Erasure is logged, not left for AuthService's private runner to swallow.
	if svc.Erasure != nil {
		authSvc.UseErasure(svc.Erasure)
	} else {
		slog.Error("wireAuth: bundle has no erasure runner; account deletion will run through AuthService's private runner, which records no deletion marker — a restore can resurrect an erased account")
	}
}
