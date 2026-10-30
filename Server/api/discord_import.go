package api

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/service/discordimport"
	"github.com/J3vb/OwnCord/Server/storage"
)

// newDiscordImporter builds the import service behind the admin routes, or nil
// when there is no upload storage to copy media into.
func newDiscordImporter(store discordimport.ServiceStore, svc *service.Services, hub discordimport.ChannelBroadcaster, files *storage.Storage, rt Runtime) admin.DiscordImporter {
	if files == nil || svc.Uploads == nil {
		return nil
	}
	return discordimport.NewService(discordimport.ServiceConfig{
		Store:   store,
		Files:   ReservedStore{Store: files},
		Uploads: svc.Uploads,
		Group:   rt.Background,
		Hub:     hub,
		Perms:   svc.Permissions,
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
// body that keeps arriving is not cut at the global 30 s timeout, for a
// lifetime sized to the upload cap.
func beginImportTransfer(w http.ResponseWriter, r *http.Request, maxBytes int64, lifetime time.Duration) (io.ReadCloser, func()) {
	// The margin keeps the 202 that answers the upload from landing on the
	// instant the lifetime ends; release re-arms the deadlines for it.
	d := startTransfer(w, r, transferProgressTimeout, lifetime+transferProgressTimeout)
	d.touch()
	return progressReader{r: http.MaxBytesReader(w, r.Body, maxBytes), d: d}, func() {
		d.touch()
		d.release()
	}
}
