package app

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
)

// wireAuth runs inside StartRuntime before the hub's dispatch goroutine starts,
// so no setter runs after Run. It shares the auth service with the bundle (the
// admin panel's owner-only recovery issuance uses it); gives the bundle's
// erasure runner the upload storage the routes serve from (what removes an
// erased account's files) and the hub (which broadcasts the member_ban and
// purges the replay pipeline); then makes the self-service route run through
// that same runner, as the admin route and the maintenance resume already do.
// A nil store leaves the file half journaled until storage is available.
// svc.Erasure and svc.Retention are guarded independently, and a missing
// svc.Erasure is logged rather than left for AuthService's private
// per-instance runner to swallow (see UseErasure).
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
			// A live target gets the mod_action frame, and a timeout's voice
			// half applies through the same mechanism voice_mod_mute uses.
			svc.Moderation.SetNotifier(hub)
			svc.Moderation.SetVoiceMuter(hub)
		}
		if svc.Appeals != nil {
			// A live appellant gets the appeal_status frame on assignment,
			// decision and withdrawal. The mod_queue broadcaster is wired too,
			// so Assign/Decide/Withdraw issue both live frames under the same
			// per-appeal lock.
			svc.Appeals.SetNotifier(hub)
			svc.Appeals.SetQueueBroadcaster(hub)
			// An overturned ban must re-add the member to every connected
			// roster, as the admin unban path does; this is the transport half.
			svc.Appeals.SetUnbanBroadcaster(hub)
		}
	}
	authSvc.UseWelcome(svc.Welcome)
	if hub != nil {
		svc.Welcome.SetNotifier(hub)
	}
	if svc.Erasure != nil {
		authSvc.UseErasure(svc.Erasure)
	} else {
		slog.Error("wireAuth: bundle has no erasure runner; account deletion will run through AuthService's private runner, which records no deletion marker — a restore can resurrect an erased account")
	}
}
