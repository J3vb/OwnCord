package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// B5-2's exit condition is "storage quotas and disk headroom fail safely
// under concurrency and restart", so these are concurrency and restart tests,
// not arithmetic ones. Every guard here has a mutation in the plan's evidence
// block that turns exactly one of these red.

const quotaTestUser = int64(1)

// newQuotaFixture builds an UploadService over a migrated database with a
// seeded user, a fake free-space probe (unknown by default: "unknown is not
// full") and the given limits.
func newQuotaFixture(t *testing.T, quota int64, minFree uint64, free func(string) (uint64, error)) (*UploadService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: quotaTestUser, Username: "quota_user", RoleID: 4})
	seedUser(t, database, &db.User{ID: 2, Username: "quota_other", RoleID: 4})
	perms := NewPermissionService(database, permissions.NewChecker(database))
	svc := NewUploadService(database, perms)
	if free == nil {
		free = func(string) (uint64, error) { return 0, errors.New("no statfs in tests") }
	}
	svc.SetStorageLimits(StorageLimits{UserQuotaBytes: quota, MinFreeBytes: minFree, Dir: t.TempDir(), FreeBytes: free})
	return svc, database
}

func used(t *testing.T, svc *UploadService, userID int64) int64 {
	t.Helper()
	n, err := svc.StorageUsed(context.Background(), userID)
	if err != nil {
		t.Fatalf("StorageUsed: %v", err)
	}
	return n
}

// seedCountedAttachment inserts an attachments row the recount will count.
func seedCountedAttachment(t *testing.T, database *db.DB, id string, uploader, size int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES (?, 'f.bin', ?, 'application/octet-stream', ?, ?)`,
		id, id, size, uploader); err != nil {
		t.Fatalf("seed attachment %s: %v", id, err)
	}
}

// commitWithRow is what a handler does on success: Record lands the row that
// names the bytes and commits the reservation under the same lock. A Commit
// with no row is not a state production reaches; a recount would rightly
// treat such a charge as a phantom.
func commitWithRow(t *testing.T, svc *UploadService, res *StorageReservation, id string, uploader, size int64) {
	t.Helper()
	rec := AttachmentRecord{ID: id, UploaderID: uploader, Filename: "f.bin", MimeType: "application/octet-stream", Size: size}
	if err := svc.Record(context.Background(), rec, res); err != nil {
		t.Errorf("Record(%s): %v", id, err)
	}
}

// race runs n goroutines against one Reserve and reports how many were
// admitted and how many refused with want. Every goroutine is released by one
// close, so they contend for real; each admission runs onAdmit (the handler's
// success path: the row lands and the reservation commits).
func race(t *testing.T, n int, reserve func() (*StorageReservation, error), onAdmit func(i int, res *StorageReservation), want error) (admitted, refused int) {
	t.Helper()
	start := make(chan struct{})
	var wg sync.WaitGroup
	var ok, no, other atomic.Int64
	for i := range n {
		wg.Go(func() {
			<-start
			res, err := reserve()
			switch {
			case err == nil:
				ok.Add(1)
				onAdmit(i, res)
			case errors.Is(err, want):
				no.Add(1)
			default:
				other.Add(1)
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
	close(start)
	wg.Wait()
	return int(ok.Load()), int(no.Load())
}

// TestReserve_ConcurrentUploadsRacingTheLastByte is the quota's exactly-k-win
// proof: with room for exactly three files, eight racers get three
// admissions and five ErrQuotaExceeded, and the counter holds three files.
func TestReserve_ConcurrentUploadsRacingTheLastByte(t *testing.T) {
	const size = int64(1000)
	svc, _ := newQuotaFixture(t, 3*size, 0, nil)
	admitted, refused := race(t, 8, func() (*StorageReservation, error) {
		return svc.Reserve(context.Background(), quotaTestUser, size)
	}, func(i int, res *StorageReservation) {
		commitWithRow(t, svc, res, fmt.Sprintf("race-%d", i), quotaTestUser, size)
	}, ErrQuotaExceeded)
	if admitted != 3 || refused != 5 {
		t.Fatalf("admitted %d, refused %d; want exactly 3 and 5", admitted, refused)
	}
	if got := used(t, svc, quotaTestUser); got != 3*size {
		t.Fatalf("counter = %d, want %d", got, 3*size)
	}
}

// TestReserve_ExactlyAtQuotaAdmitsOnePastRefuses pins the boundary the guard
// clause states: bytes_used + n <= quota admits, one byte more refuses.
func TestReserve_ExactlyAtQuotaAdmitsOnePastRefuses(t *testing.T) {
	svc, _ := newQuotaFixture(t, 100, 0, nil)
	ctx := context.Background()
	res, err := svc.Reserve(ctx, quotaTestUser, 100)
	if err != nil {
		t.Fatalf("exactly-at-quota refused: %v", err)
	}
	commitWithRow(t, svc, res, "full", quotaTestUser, 100)
	if _, err := svc.Reserve(ctx, quotaTestUser, 1); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("one byte past quota: got %v, want ErrQuotaExceeded", err)
	}
	if _, err := svc.Reserve(ctx, 2, 100); err != nil {
		t.Fatalf("another user's quota is their own: %v", err)
	}
}

// TestReserve_UnlimitedQuotaStillCountsBytes pins decision 11's default: no
// quota refuses nothing, but the counter is maintained so a quota set later
// starts from a live number.
func TestReserve_UnlimitedQuotaStillCountsBytes(t *testing.T) {
	svc, _ := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	for i := range 5 {
		res, err := svc.Reserve(ctx, quotaTestUser, 1<<30)
		if err != nil {
			t.Fatalf("upload %d refused under an unlimited quota: %v", i, err)
		}
		res.Commit()
	}
	if got := used(t, svc, quotaTestUser); got != 5<<30 {
		t.Fatalf("counter = %d under an unlimited quota, want %d", got, int64(5)<<30)
	}
}

// TestReserve_HeadroomRacersAdmitExactlyWhatFits is the floor's concurrency
// proof: 300 MiB free, a 256 MiB floor and 10 MiB uploads leave room for
// four. Eight racers reserve and hold, so the in-flight sum is the only
// arbiter: exactly four admissions and four ErrLowDisk, every run.
func TestReserve_HeadroomRacersAdmitExactlyWhatFits(t *testing.T) {
	const size = int64(10 << 20)
	svc, _ := newQuotaFixture(t, 0, 256<<20, func(string) (uint64, error) { return 300 << 20, nil })
	var held []*StorageReservation
	var mu sync.Mutex
	admitted, refused := race(t, 8, func() (*StorageReservation, error) {
		return svc.Reserve(context.Background(), quotaTestUser, size)
	}, func(_ int, res *StorageReservation) {
		mu.Lock()
		held = append(held, res)
		mu.Unlock()
	}, ErrLowDisk)
	if admitted != 4 || refused != 4 {
		t.Fatalf("admitted %d, refused %d; want exactly 4 and 4", admitted, refused)
	}
	for _, res := range held {
		res.Release(context.Background())
	}
	if _, err := svc.Reserve(context.Background(), quotaTestUser, size); err != nil {
		t.Fatalf("after the holds were released the space is free again: %v", err)
	}
}

// TestReserve_HeadroomRacersNeverOverAdmitWhileBytesLand is the same race
// against a volume that shrinks as bytes land, the way a real one does:
// each admission lands its bytes (the probe sees them), marks the
// reservation Landed (the in-flight sum stops counting them) and records its
// row. The exact count now depends on timing — an upload judged between a
// landing and its Landed is refused for bytes counted twice, the safe side —
// but the floor is never crossed: the volume never drops under 256 MiB, so
// never more than four are admitted.
func TestReserve_HeadroomRacersNeverOverAdmitWhileBytesLand(t *testing.T) {
	const size = int64(10 << 20)
	var onDisk atomic.Uint64
	svc, _ := newQuotaFixture(t, 0, 256<<20, func(string) (uint64, error) { return 300<<20 - onDisk.Load(), nil })
	admitted, refused := race(t, 8, func() (*StorageReservation, error) {
		return svc.Reserve(context.Background(), quotaTestUser, size)
	}, func(i int, res *StorageReservation) {
		onDisk.Add(uint64(size)) // the bytes are on the volume before the row lands
		res.Landed()
		commitWithRow(t, svc, res, fmt.Sprintf("race-%d", i), quotaTestUser, size)
	}, ErrLowDisk)
	if admitted > 4 || admitted < 1 || admitted+refused != 8 {
		t.Fatalf("admitted %d, refused %d; want 1..4 admitted and the floor never crossed", admitted, refused)
	}
	if free := 300<<20 - onDisk.Load(); free < 256<<20 {
		t.Fatalf("the volume dropped to %d MiB, under the floor", free>>20)
	}
}

// TestReserve_FreeBelowFloorWithReservationOutstandingRefuses is the case an
// unsigned subtraction gets backwards: 100 MiB free, a 256 MiB floor and 200
// MiB already in flight must refuse the next byte, not wrap and admit it.
func TestReserve_FreeBelowFloorWithReservationOutstandingRefuses(t *testing.T) {
	free := atomic.Uint64{}
	free.Store(600 << 20)
	svc, _ := newQuotaFixture(t, 0, 256<<20, func(string) (uint64, error) { return free.Load(), nil })
	ctx := context.Background()
	held, err := svc.Reserve(ctx, quotaTestUser, 200<<20)
	if err != nil {
		t.Fatalf("first reservation with 600 MiB free: %v", err)
	}
	defer held.Release(ctx)
	free.Store(100 << 20) // the volume filled underneath us
	if _, err := svc.Reserve(ctx, 2, 1); !errors.Is(err, ErrLowDisk) {
		t.Fatalf("free < floor with 200 MiB in flight: got %v, want ErrLowDisk", err)
	}
	if err := svc.CheckHeadroom(1); !errors.Is(err, ErrLowDisk) {
		t.Fatalf("CheckHeadroom under the floor: got %v, want ErrLowDisk", err)
	}
}

// TestReserve_UnknownFreeSpaceIsNotFull locks the repository rule the health
// check and the banner already follow: a probe error admits.
func TestReserve_UnknownFreeSpaceIsNotFull(t *testing.T) {
	svc, _ := newQuotaFixture(t, 0, 256<<20, nil)
	if _, err := svc.Reserve(context.Background(), quotaTestUser, 1<<30); err != nil {
		t.Fatalf("a failed probe refused an upload: %v", err)
	}
	if err := svc.CheckHeadroom(1 << 30); err != nil {
		t.Fatalf("CheckHeadroom on a failed probe: %v", err)
	}
}

// TestReserve_ReleaseReturnsTheCharge: a failed write gives the bytes back,
// and Release is idempotent.
func TestReserve_ReleaseReturnsTheCharge(t *testing.T) {
	svc, _ := newQuotaFixture(t, 100, 0, nil)
	ctx := context.Background()
	res, err := svc.Reserve(ctx, quotaTestUser, 60)
	if err != nil {
		t.Fatal(err)
	}
	res.Release(ctx)
	res.Release(ctx)
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after Release, want 0", got)
	}
	if _, err := svc.Reserve(ctx, quotaTestUser, 100); err != nil {
		t.Fatalf("the released bytes were not returned: %v", err)
	}
}

// TestRecount_RepairsAChargeWithNoFileAfterRestart is the crash between the
// charge and the write: the counter is charged, the process dies, and a new
// service over the same database (no in-flight memory) recounts it to the
// rows — zero.
func TestRecount_RepairsAChargeWithNoFileAfterRestart(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	if _, err := svc.Reserve(ctx, quotaTestUser, 4096); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 4096 {
		t.Fatalf("charge not durable: %d", got)
	}
	// "Restart": a fresh service over the same database. The reservation
	// object is gone with the old process.
	restarted := NewUploadService(database, NewPermissionService(database, permissions.NewChecker(database)))
	if n, err := restarted.RecountStorage(ctx); err != nil || n != 1 {
		t.Fatalf("RecountStorage = %d, %v; want 1 user, nil", n, err)
	}
	if got := used(t, restarted, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after the restart recount, want 0 (no row, no file)", got)
	}
}

// TestRecount_KeepsInFlightBytes: a recount that runs while an upload is
// between its charge and its row must not wipe the charge (that would be an
// under-count the moment the row lands). After Release the recount drops it.
func TestRecount_KeepsInFlightBytes(t *testing.T) {
	svc, _ := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	res, err := svc.Reserve(ctx, quotaTestUser, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 500 {
		t.Fatalf("counter = %d with 500 in flight, want 500 kept", got)
	}
	res.Release(ctx)
	if _, err := svc.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after Release + recount, want 0", got)
	}
}

// TestRecount_ALeakedReservationDoesNotDisableRepair: a reservation nobody
// settled (a panic between Save and Commit, say) must not turn the recount
// off for that user. The counter may over-count by the leak, never under, and
// deletions are still returned.
func TestRecount_ALeakedReservationDoesNotDisableRepair(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	if _, err := svc.Reserve(ctx, quotaTestUser, 100); err != nil { // never settled
		t.Fatal(err)
	}
	seedCountedAttachment(t, database, "att-1", quotaTestUser, 900)
	if _, err := svc.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 1000 {
		t.Fatalf("counter = %d, want 1000 (900 in rows + the 100 leak, never less)", got)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM attachments WHERE id = 'att-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 100 {
		t.Fatalf("counter = %d after the row went, want 100: the leak must not block returning the 900", got)
	}
}

// TestRecount_ReturnsBytesAfterErasure: the erasure transaction takes the
// counter row with the account (class 12a), so an erased subject holds
// nothing and a recount over the survivors is unaffected.
func TestRecount_ReturnsBytesAfterErasure(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	res, err := svc.Reserve(ctx, quotaTestUser, 300)
	if err != nil {
		t.Fatal(err)
	}
	commitWithRow(t, svc, res, "att-1", quotaTestUser, 300)
	if _, err := database.EraseAccount(ctx, quotaTestUser, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_storage WHERE user_id = ?`, quotaTestUser).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("user_storage row survived the erasure")
	}
	if n, err := svc.RecountStorage(ctx); err != nil || n != 0 {
		t.Fatalf("RecountStorage after erasure = %d, %v; want 0 users, nil", n, err)
	}
}

// TestRecount_ReturnsBytesAfterRetention: rows the retention sweep deletes
// leave the counter high until the tick's recount lowers it to the rows.
func TestRecount_ReturnsBytesAfterRetention(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	keep, err := svc.Reserve(ctx, quotaTestUser, 200)
	if err != nil {
		t.Fatal(err)
	}
	commitWithRow(t, svc, keep, "att-keep", quotaTestUser, 200)
	old, err := svc.Reserve(ctx, quotaTestUser, 500)
	if err != nil {
		t.Fatal(err)
	}
	commitWithRow(t, svc, old, "att-old", quotaTestUser, 500)
	// What the sweep does to the rows, in miniature.
	if _, err := database.ExecContext(ctx, `DELETE FROM attachments WHERE id = 'att-old'`); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 700 {
		t.Fatalf("counter = %d before the recount, want 700 (high is the safe side)", got)
	}
	if _, err := svc.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, svc, quotaTestUser); got != 200 {
		t.Fatalf("counter = %d after the recount, want 200", got)
	}
}

// TestReserve_ARefusalRecountsBeforeAnswering: a user at quota whose rows
// were just deleted (a sweep ran, the tick's recount has not) is not made to
// wait for the tick — a refused reserve recounts that one user and retries.
func TestReserve_ARefusalRecountsBeforeAnswering(t *testing.T) {
	svc, database := newQuotaFixture(t, 1000, 0, nil)
	ctx := context.Background()
	res, err := svc.Reserve(ctx, quotaTestUser, 1000)
	if err != nil {
		t.Fatal(err)
	}
	commitWithRow(t, svc, res, "att-1", quotaTestUser, 1000)
	if _, err := svc.Reserve(ctx, quotaTestUser, 1); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("full quota admitted: %v", err)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM attachments WHERE id = 'att-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Reserve(ctx, quotaTestUser, 600); err != nil {
		t.Fatalf("freed bytes were not usable before the tick: %v", err)
	}
	if got := used(t, svc, quotaTestUser); got != 600 {
		t.Fatalf("counter = %d, want 600", got)
	}
}

// TestRecount_RestartMidSweepLeavesFinishedUsersExact: a sweep cancelled
// between users leaves every finished user exact and the rest stale; the next
// sweep finishes them. Nothing half-applied, nothing lost.
func TestRecount_RestartMidSweepLeavesFinishedUsersExact(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, u := range []int64{quotaTestUser, 2} {
		// A dead process's charges: durable, no row, no in-flight memory.
		if _, err := database.ExecContext(ctx, `INSERT INTO user_storage (user_id, bytes_used) VALUES (?, 50)`, u); err != nil {
			t.Fatal(err)
		}
	}
	svc.quota.afterRecount = func(int64) { cancel() } // "the process dies after the first user"
	n, err := svc.RecountStorage(ctx)
	if !errors.Is(err, context.Canceled) || n != 1 {
		t.Fatalf("RecountStorage = %d, %v; want 1 finished user and context.Canceled", n, err)
	}
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("finished user = %d, want 0 (exact)", got)
	}
	if got := used(t, svc, 2); got != 50 {
		t.Fatalf("unfinished user = %d, want 50 (untouched, still on the safe side)", got)
	}
	svc.quota.afterRecount = nil
	if n, err := svc.RecountStorage(context.Background()); err != nil || n != 2 {
		t.Fatalf("second sweep = %d, %v; want 2, nil", n, err)
	}
	if got := used(t, svc, 2); got != 0 {
		t.Fatalf("user 2 = %d after the second sweep, want 0", got)
	}
}

// TestReserveHeadroom_EmojiIsBoundedAndFloorOnly is the proof behind the
// emoji exclusion: an emoji write goes through the floor but charges no
// counter, and the exclusion is bounded by two constants and a permission
// (service.MaxEmojiCount, api.maxEmojiFileBytes, MANAGE_SERVER in
// EmojiService.RequireManage) rather than by good behaviour.
func TestReserveHeadroom_EmojiIsBoundedAndFloorOnly(t *testing.T) {
	svc, _ := newQuotaFixture(t, 10, 256<<20, func(string) (uint64, error) { return 100 << 20, nil })
	if _, err := svc.ReserveHeadroom(context.Background(), 11); !errors.Is(err, ErrLowDisk) {
		t.Fatalf("emoji bytes skipped the floor: %v", err)
	}
	svc.SetStorageLimits(StorageLimits{UserQuotaBytes: 10, FreeBytes: func(string) (uint64, error) { return 100 << 20, nil }})
	res, err := svc.ReserveHeadroom(context.Background(), 11)
	if err != nil {
		t.Fatalf("emoji bytes charged against a quota they are excluded from: %v", err)
	}
	res.Commit()
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after an emoji write, want 0", got)
	}
	// The bound itself, so a raised cap is a conscious edit here too.
	const maxEmojiFileBytes = 512 << 10 // api/constants.go
	if bound := int64(MaxEmojiCount) * maxEmojiFileBytes; bound > 100<<20 {
		t.Fatalf("emoji exclusion bound = %d bytes, want at most 100 MiB — re-decide the exclusion", bound)
	}
}

// TestReserve_NegativeSizeIsRefused: a negative size would be a free
// uncharge; it is a bad request, not a charge of -n.
func TestReserve_NegativeSizeIsRefused(t *testing.T) {
	svc, _ := newQuotaFixture(t, 0, 0, nil)
	if _, err := svc.Reserve(context.Background(), quotaTestUser, -1); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("Reserve(-1) = %v, want ErrBadRequest", err)
	}
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter moved on a refused negative size: %d", got)
	}
}

// TestReserve_RestartForgetsInFlightButKeepsCharges documents the restart
// contract in one place: nothing in memory survives, every charge does, and
// the first recount (the maintenance loop's start) settles them.
func TestReserve_RestartForgetsInFlightButKeepsCharges(t *testing.T) {
	svc, database := newQuotaFixture(t, 0, 0, nil)
	ctx := context.Background()
	for i := range 3 {
		if _, err := svc.Reserve(ctx, quotaTestUser, int64(100*(i+1))); err != nil {
			t.Fatal(err)
		}
	}
	seedCountedAttachment(t, database, "landed", quotaTestUser, 100) // one of them made it to a row
	restarted := NewUploadService(database, NewPermissionService(database, permissions.NewChecker(database)))
	if got := used(t, restarted, quotaTestUser); got != 600 {
		t.Fatalf("charges before the first recount = %d, want 600 (all kept, high side)", got)
	}
	if _, err := restarted.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if got := used(t, restarted, quotaTestUser); got != 100 {
		t.Fatalf("after the first recount = %d, want 100 (the row that landed)", got)
	}
}
