package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// The per-user upload byte counter and the reserved-headroom floor. The
// `attachments` rows are the truth; the `user_storage` counter is the cached
// aggregate uploads are admitted against. Its safety rests on three rules:
//
//  1. Charge BEFORE the store write. A crash after Reserve leaves the counter
//     high, never low; the maintenance recount lowers it. Admission is one guarded
//     UPDATE, so of N uploads racing the last byte exactly those that fit are
//     admitted (SQLite serialises writers).
//  2. The in-process half (bytes reserved but not yet written or rowed) lives
//     under one mutex with the charge. A recount sets rows + in-flight, so it
//     never wipes a live reservation (an under-count once the row lands); the only
//     transient error is an over-count while a Commit is pending.
//  3. The headroom check is addition only, in the probe's unsigned type: refuse
//     when free < floor + in-flight + n. A subtraction would wrap exactly when the
//     disk is full and admit everything.
//
// Emoji are excluded from the quota, not the floor: server-wide assets that change
// owner on erasure, gated on MANAGE_SERVER, capped at MaxEmojiCount files of
// api.maxEmojiFileBytes.

// ErrQuotaExceeded is returned by Reserve when the upload would pass
// upload.user_quota_mb; handlers answer 507 STORAGE_QUOTA_EXCEEDED.
var ErrQuotaExceeded = errors.New("upload would exceed your storage quota")

// ErrLowDisk is returned by Reserve when the upload would take the volume under
// server.min_free_disk_mb; handlers answer 507 STORAGE_LOW_DISK.
var ErrLowDisk = errors.New("server storage is below its reserved headroom")

// StorageLimits is what the upload path admits against.
type StorageLimits struct {
	// UserQuotaBytes caps one user's counted bytes; 0 is unlimited.
	UserQuotaBytes int64
	// MinFreeBytes is the reserved headroom on Dir's volume; 0 is no floor.
	MinFreeBytes uint64
	// Dir is the upload directory whose volume is probed.
	Dir string
	// FreeBytes probes free space; nil means diskutil.FreeBytes. A probe error is
	// "unknown", never "full".
	FreeBytes func(dir string) (uint64, error)
	// MaxUploadBytes is upload.max_size_mb in bytes, the per-file cap
	// storage.Storage enforces during Save. It bounds what an unknown-length request
	// can cost; 0 means unset (falls back to the request cap).
	MaxUploadBytes int64
	// FileTypes is the config.yaml file-type policy; FileTypePolicy lets a list saved
	// in the admin panel replace either of its lists.
	FileTypes storage.FileTypePolicy
}

type storageQuota struct {
	mu     syncutil.Mutex
	limits StorageLimits
	// inflight is bytes charged per user whose store write or row insert is
	// incomplete; inflightTotal adds headroom-only reservations: the floor's view of
	// writes still landing.
	inflight      map[int64]int64
	inflightTotal uint64
	// afterRecount is a test seam called after each user's recount, to cancel the
	// sweep between users.
	afterRecount func(userID int64)
}

// StorageReservation is one admitted write's charge. Exactly one of Commit or
// Release must follow; a deferred Settle makes Release the default so a panic or
// early return between Save and Commit cannot leak it.
type StorageReservation struct {
	s      *UploadService
	userID int64
	bytes  int64
	// ubytes is bytes as the floor counts it, fixed once n >= 0 is known.
	ubytes  uint64
	charged bool
	// landed is set by Landed once the bytes are on disk: the probe then sees them, so
	// the floor's in-flight sum must not.
	landed    bool
	committed bool
	released  bool
}

// SetStorageLimits installs the limits; the root calls it before the hub first
// reads the file-type policy.
func (s *UploadService) SetStorageLimits(l StorageLimits) {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	s.quota.limits = l
}

// MaxUploadBytes reports the per-file cap (0 means unset), so a caller reserving
// before it knows a request's size (unknown-length body) bounds the reservation by
// one file's cost, not the request cap.
func (s *UploadService) MaxUploadBytes() int64 {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	return s.quota.limits.MaxUploadBytes
}

// fitsLocked reports whether n more bytes leave the floor intact. The probe runs
// under the lock on purpose: a reading taken before earlier uploads landed, judged
// after they committed (leaving the in-flight sum), under-counts the volume and
// over-admits. A statfs is microseconds and the DB charge has to be inside anyway
// (see reserve). No floor or a failed probe is "unknown", never "full", and fits.
// Addition only: free is unsigned and a subtraction wraps when the disk is full;
// an addition that wraps cannot fit either.
func (q *storageQuota) fitsLocked(n int64) bool {
	if n < 0 {
		return false
	}
	if q.limits.MinFreeBytes == 0 {
		return true
	}
	probe := q.limits.FreeBytes
	if probe == nil {
		probe = diskutil.FreeBytes
	}
	free, err := probe(q.limits.Dir)
	if err != nil {
		return true
	}
	need := q.limits.MinFreeBytes + q.inflightTotal + uint64(n)
	if need < q.limits.MinFreeBytes {
		return false
	}
	return free >= need
}

// Reserve admits n bytes for userID against both bounds and charges the counter,
// or refuses with ErrQuotaExceeded / ErrLowDisk.
func (s *UploadService) Reserve(ctx context.Context, userID, n int64) (*StorageReservation, error) {
	return s.reserve(ctx, userID, n, true)
}

// ReserveHeadroom admits n bytes against the headroom floor only, for a write
// excluded from the per-user quota (emoji).
func (s *UploadService) ReserveHeadroom(ctx context.Context, n int64) (*StorageReservation, error) {
	return s.reserve(ctx, 0, n, false)
}

func (s *UploadService) reserve(ctx context.Context, userID, n int64, charge bool) (*StorageReservation, error) {
	if n < 0 {
		return nil, fmt.Errorf("%w: negative upload size", ErrBadRequest)
	}
	q := &s.quota
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.fitsLocked(n) {
		return nil, ErrLowDisk
	}
	if charge {
		if err := s.chargeLocked(ctx, userID, n); err != nil {
			return nil, err
		}
		if q.inflight == nil {
			q.inflight = make(map[int64]int64)
		}
		q.inflight[userID] += n
	}
	ubytes := uint64(n)
	q.inflightTotal += ubytes
	return &StorageReservation{s: s, userID: userID, bytes: n, ubytes: ubytes, charged: charge}, nil
}

// chargeLocked charges n against userID's quota. On refusal it recounts that one
// user from the rows (a sweep may have freed bytes since the last tick) and tries
// once more, so deleting files frees space without waiting for the tick. Paid only
// on the refusal path.
func (s *UploadService) chargeLocked(ctx context.Context, userID, n int64) error {
	quota, err := s.effectiveQuotaLocked(ctx, userID)
	if err != nil {
		return err
	}
	ok, err := s.st.ChargeUserStorage(ctx, userID, n, quota)
	if err != nil {
		return fmt.Errorf("%w: storage charge: %w", ErrInternal, err)
	}
	if ok {
		return nil
	}
	if err := s.recountLocked(ctx, userID); err != nil {
		return err
	}
	ok, err = s.st.ChargeUserStorage(ctx, userID, n, quota)
	if err != nil {
		return fmt.Errorf("%w: storage charge: %w", ErrInternal, err)
	}
	if !ok {
		return ErrQuotaExceeded
	}
	return nil
}

// recountLocked sets one user's counter to the rows plus their in-flight bytes.
// Two statements, but under the lock nothing else moves the user between them, and
// a crash between leaves the rows' value, right for a process whose in-flight
// writes died with it.
func (s *UploadService) recountLocked(ctx context.Context, userID int64) error {
	if err := s.st.RecountUserStorage(ctx, userID); err != nil {
		return fmt.Errorf("%w: storage recount: %w", ErrInternal, err)
	}
	if inflight := s.quota.inflight[userID]; inflight > 0 {
		if _, err := s.st.ChargeUserStorage(ctx, userID, inflight, 0); err != nil {
			return fmt.Errorf("%w: storage recount: %w", ErrInternal, err)
		}
	}
	return nil
}

// Landed records that the store write succeeded: the bytes are on the volume and
// the probe counts them, so the floor's in-flight sum drops them here, not at
// Commit. Otherwise the same bytes count twice (probe plus in-flight) while the
// row insert runs and a concurrent upload is refused for space not used twice. The
// per-user quota share stays in flight until Commit or Release.
func (r *StorageReservation) Landed() {
	if r == nil || r.landed || r.committed || r.released {
		return
	}
	q := &r.s.quota
	q.mu.Lock()
	defer q.mu.Unlock()
	r.landed = true
	q.inflightTotal -= r.ubytes
}

// Resize lowers a reservation to the bytes actually written. It never raises one:
// bytes above the admitted envelope were never admitted against quota or floor. A
// no-op for n < 0, n >= current bytes, or a committed/released reservation, so a
// repeat or late call is safe.
func (r *StorageReservation) Resize(ctx context.Context, n int64) error {
	if r == nil || n < 0 {
		return nil
	}
	q := &r.s.quota
	q.mu.Lock()
	defer q.mu.Unlock()
	if n >= r.bytes || r.committed || r.released {
		return nil
	}
	delta := r.bytes - n
	if r.charged {
		if err := r.s.st.ReleaseUserStorage(ctx, r.userID, delta); err != nil {
			return fmt.Errorf("%w: storage resize: %w", ErrInternal, err)
		}
		if left := q.inflight[r.userID] - delta; left > 0 {
			q.inflight[r.userID] = left
		} else {
			delete(q.inflight, r.userID)
		}
	}
	if !r.landed {
		q.inflightTotal -= uint64(delta) //nolint:gosec // G115: delta = r.bytes - n, both already checked >= 0 above (n < 0 returns early, n >= r.bytes returns early), so delta is positive and within r.bytes
	}
	r.bytes = n
	r.ubytes = uint64(n)
	return nil
}

// Commit keeps the charge: the bytes are on disk and their row exists. A charged
// reservation is committed by UploadService.Record under the same lock as its row
// insert, so a recount never sees the file in both rows and in flight; Commit is
// for headroom-only reservations.
func (r *StorageReservation) Commit() {
	if r == nil || r.committed || r.released {
		return
	}
	q := &r.s.quota
	q.mu.Lock()
	defer q.mu.Unlock()
	r.commitLocked()
}

func (r *StorageReservation) commitLocked() {
	if r.committed || r.released {
		return
	}
	r.committed = true
	r.dropInflightLocked()
}

// Release returns the charge after a failed write or row. Idempotent, and safe on
// a canceled ctx: a client that vanished mid-upload still gets its bytes back.
func (r *StorageReservation) Release(ctx context.Context) {
	if r == nil || r.committed || r.released {
		return
	}
	q := &r.s.quota
	q.mu.Lock()
	defer q.mu.Unlock()
	r.released = true
	r.dropInflightLocked()
	if !r.charged {
		return
	}
	if err := r.s.st.ReleaseUserStorage(context.WithoutCancel(ctx), r.userID, r.bytes); err != nil {
		// The counter stays high, the safe side; the next recount lowers it.
		slog.Warn("storage: could not release a charge; the next recount will", "user_id", r.userID, "bytes", r.bytes, "error", err)
	}
}

// Settle is Release unless Commit ran: the deferred safety net.
func (r *StorageReservation) Settle(ctx context.Context) {
	if r != nil && !r.committed {
		r.Release(ctx)
	}
}

func (r *StorageReservation) dropInflightLocked() {
	q := &r.s.quota
	if !r.landed {
		q.inflightTotal -= r.ubytes
	}
	if !r.charged {
		return
	}
	if left := q.inflight[r.userID] - r.bytes; left > 0 {
		q.inflight[r.userID] = left
	} else {
		delete(q.inflight, r.userID)
	}
}

// RecountStorage sets every counter to its rows plus in-flight bytes, one user per
// statement, and reports how many it finished; a canceled ctx stops between users,
// leaving finished users exact and the rest on the high side.
func (s *UploadService) RecountStorage(ctx context.Context) (int, error) {
	ids, err := s.st.ListUserStorageIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("%w: storage recount: %w", ErrInternal, err)
	}
	done := 0
	for _, userID := range ids {
		if err := ctx.Err(); err != nil {
			return done, err
		}
		s.quota.mu.Lock()
		err := s.recountLocked(ctx, userID)
		s.quota.mu.Unlock()
		if err != nil {
			return done, err
		}
		done++
		if hook := s.quota.afterRecount; hook != nil {
			hook(userID)
		}
	}
	return done, nil
}

// StorageUsed reports userID's counter.
func (s *UploadService) StorageUsed(ctx context.Context, userID int64) (int64, error) {
	return s.st.UserStorageUsed(ctx, userID)
}
