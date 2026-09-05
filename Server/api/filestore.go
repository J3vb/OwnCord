package api

import (
	"context"
	"errors"
	"io"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// FileStore is the consumer-side seam over blob storage, following the repo's
// interface-at-the-consumer pattern (see service.Store, D3): the api package
// declares exactly the three operations its handlers use, and the concrete
// *storage.Storage satisfies it. This is deliberately an interface carve-out,
// NOT an alternative-backend implementation — multi-backend storage (S3 and
// friends) is out of scope today. What the seam buys now is that the
// contract an alternative backend would have to meet is written down where
// it is consumed; note in particular that Open must return a seekable file
// (storage.File), because the serve paths use http.ServeContent for range
// requests.
type FileStore interface {
	// Save writes r to a file named by uuid, validating content type by
	// magic bytes and enforcing the size limit. Filesystem-level failures
	// carry storage.ErrIO.
	Save(uuid string, r io.Reader) (int64, error)
	// Delete removes the stored file named uuid.
	Delete(uuid string) error
	// Open opens the stored file named uuid for seekable reading.
	Open(uuid string) (storage.File, error)
}

// compile-time proof the disk implementation satisfies the seam.
var _ FileStore = (*storage.Storage)(nil)

// saveReserved is the one production path that writes through a FileStore
// (B5-2, decision 11): every byte the store takes has been admitted first —
// by UploadService.Reserve, which charges the uploader's counter and checks
// the headroom floor, or by ReserveHeadroom for the bounded emoji exclusion.
// A failed write hands the reservation back; a successful one is the
// caller's to commit once its row exists (UploadService.Record does that
// under the same lock) or to settle in a defer.
//
// TestEveryFileStoreSaveIsReserved fails on any other Save call site. What
// that proves is exactly "no second call to FileStore.Save"; a write that
// bypasses the store (os.WriteFile into the directory) is outside it.
func saveReserved(ctx context.Context, res *service.StorageReservation, store FileStore, name string, r io.Reader) (int64, error) {
	if res == nil {
		return 0, errors.New("api: store write without a storage reservation")
	}
	written, err := store.Save(name, r)
	if err != nil {
		res.Release(ctx)
		return 0, err
	}
	res.Landed()
	return written, nil
}
