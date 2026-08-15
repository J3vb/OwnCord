package api

import (
	"io"

	"github.com/owncord/server/storage"
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
