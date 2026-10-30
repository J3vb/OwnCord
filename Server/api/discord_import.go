package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/service/discordimport"
	"github.com/J3vb/OwnCord/Server/storage"
)

// channelBroadcaster is the hub call an import makes once, when its channel
// becomes visible.
type channelBroadcaster interface {
	BroadcastChannelCreate(ch *db.Channel)
}

// importAnnouncer tells everyone about a finished import's channel the way a
// normal channel create does.
type importAnnouncer struct {
	perms *service.PermissionService
	hub   channelBroadcaster
}

// ChannelCreated drops cached permissions, since the channel started as a copy
// of its category's template, and then sends channel_create.
func (a importAnnouncer) ChannelCreated(_ context.Context, ch *db.Channel) {
	if a.perms != nil {
		a.perms.InvalidateAll()
	}
	a.hub.BroadcastChannelCreate(ch)
}

// newDiscordImporter builds the runner behind the admin import routes, or nil
// when there is no upload storage to copy media into.
func newDiscordImporter(database *db.DB, svc *service.Services, hub channelBroadcaster, store *storage.Storage, rt Runtime) admin.DiscordImporter {
	if store == nil || svc.Uploads == nil {
		return nil
	}
	return discordimport.NewRunner(discordimport.Config{
		Store:     database,
		Files:     ReservedStore{Store: store},
		Uploads:   svc.Uploads,
		Announcer: importAnnouncer{perms: svc.Permissions, hub: hub},
		Group:     rt.Background,
	})
}

// importTempDir is where uploaded exports wait while they import. A previous
// run's leftovers are cleared first: nothing is importing at start-up.
func importTempDir(cfg *config.Config) string {
	if cfg.Server.DataDir == "" {
		return ""
	}
	dir := filepath.Join(cfg.Server.DataDir, admin.ImportDirName)
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("could not clear the import upload directory", "error", err)
	}
	return dir
}

// beginImportTransfer gives the export upload the long-transfer deadline: a
// body that keeps arriving is not cut at the global 30 s timeout.
func beginImportTransfer(w http.ResponseWriter, r *http.Request, maxBytes int64) (io.ReadCloser, func()) {
	d := newTransferDeadline(w, r)
	d.touch()
	return progressReader{r: http.MaxBytesReader(w, r.Body, maxBytes), d: d}, d.release
}
