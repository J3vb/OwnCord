package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// failingStore is a FileStore whose Save always fails: the write-side failure
// (disk full, permissions) after the charge has been taken.
type failingStore struct{}

func (failingStore) Save(string, io.Reader) (int64, error) {
	return 0, errors.New("simulated write failure")
}
func (failingStore) Delete(string) error               { return nil }
func (failingStore) Open(string) (storage.File, error) { return nil, errors.New("no file") }
func (failingStore) OpenThumb(string) (storage.File, error) {
	return nil, errors.New("no file")
}
func (failingStore) SaveThumb(string, []byte) error { return errors.New("simulated write failure") }

// TestSaveReserved_ReleasesTheChargeOnAFailedWrite pins saveReserved's own
// guarantee, independent of the handlers' deferred Settle: a caller that
// takes no defer still gets the charge back when the store refuses the
// bytes. The handler-level tests cannot see this — their Settle would
// release it anyway — which is exactly why it has its own test.
func TestSaveReserved_ReleasesTheChargeOnAFailedWrite(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	uploads := service.NewUploadService(database, service.NewPermissionService(database, permissions.NewChecker(database)))
	uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: 1 << 20})

	res, err := uploads.Reserve(ctx, 10, 512)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := saveReserved(ctx, res, failingStore{}, "f", bytes.NewReader(make([]byte, 512))); err == nil {
		t.Fatal("saveReserved returned nil for a failed write")
	}
	if used, err := uploads.StorageUsed(ctx, 10); err != nil || used != 0 {
		t.Fatalf("counter = %d, %v after a failed write with no deferred Settle; want 0", used, err)
	}
	if _, err := saveReserved(ctx, nil, failingStore{}, "f", bytes.NewReader(nil)); err == nil {
		t.Fatal("saveReserved accepted a nil reservation")
	}
}

// ReservedStore is the door the Discord import writes through: it must refuse a
// write with no reservation and hand a reservation back on a failed write, just
// as saveReserved does for the handlers.
func TestReservedStore_RefusesAnUnreservedWriteAndReleasesOnFailure(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	uploads := service.NewUploadService(database, nil)

	store := ReservedStore{Store: failingStore{}}
	if _, err := store.SaveReserved(ctx, nil, "f", bytes.NewReader([]byte("x"))); err == nil {
		t.Fatal("a write with no reservation was accepted")
	}
	res, err := uploads.ReserveHeadroom(ctx, 8)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveReserved(ctx, res, "f", bytes.NewReader([]byte("x"))); err == nil {
		t.Fatal("a failed write reported success")
	}
	// The failed write released the reservation, so settling is a no-op.
	res.Settle(ctx)

	disk, err := storage.New(t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	store = ReservedStore{Store: disk}
	res, err = uploads.ReserveHeadroom(ctx, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Settle(ctx)
	n, err := store.SaveReserved(ctx, res, "ok", bytes.NewReader([]byte("hello")))
	if err != nil || n != 5 {
		t.Fatalf("SaveReserved = %d, %v; want 5, nil", n, err)
	}
	if err := store.Delete("ok"); err != nil {
		t.Errorf("Delete: %v", err)
	}
}
