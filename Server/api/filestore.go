package api

import (
	"context"
	"errors"
	"io"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// FileStore is the consumer-side seam over blob storage: the api package
// declares exactly the operations its handlers use and *storage.Storage
// satisfies it. It is an interface carve-out, not an alternative-backend
// implementation; the contract worth writing down is that Open must return a
// seekable file (storage.File), because the serve paths use http.ServeContent
// for range requests.
type FileStore interface {
	// Save writes r to a file named by uuid, validating content type by
	// magic bytes and enforcing the size limit. Filesystem-level failures
	// carry storage.ErrIO.
	Save(uuid string, r io.Reader) (int64, error)
	Delete(uuid string) error
	Open(uuid string) (storage.File, error)
	// OpenThumb and SaveThumb read and keep the thumbnail of the original
	// named uuid; Delete removes it with the original. An empty thumbnail
	// records that the original is served instead.
	OpenThumb(uuid string) (storage.File, error)
	SaveThumb(uuid string, data []byte) error
}

var _ FileStore = (*storage.Storage)(nil)

// saveReserved is the one production path that writes through a FileStore: every
// byte has been admitted first by UploadService.Reserve (charges the uploader's
// counter, checks the headroom floor) or ReserveHeadroom (the bounded emoji
// exclusion). A failed write hands the reservation back; a successful one is the
// caller's to commit (UploadService.Record, under the same lock) or settle in a
// defer. TestEveryFileStoreSaveIsReserved fails on any other Save call site; a
// write bypassing the store (os.WriteFile) is outside it.
func saveReserved(ctx context.Context, res *service.StorageReservation, store FileStore, name string, r io.Reader) (int64, error) {
	if res == nil {
		return 0, errors.New("api: store write without a storage reservation")
	}
	written, err := store.Save(name, r)
	if err != nil {
		res.Release(ctx)
		return 0, err
	}
	// An unknown or generous declared length reserves more than the
	// upload turns out to cost; lower the charge to what was actually
	// written before the reservation lands. A failure here leaves the
	// counter high — the safe side — and the next maintenance recount
	// repairs it (migrations/044_user_storage.sql), so it must not fail
	// the upload itself.
	if err := res.Resize(ctx, written); err != nil {
		slog.Error("storage: could not resize a reservation to the bytes written", "bytes_written", written, "error", err)
	}
	res.Landed()
	return written, nil
}
