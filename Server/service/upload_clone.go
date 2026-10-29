package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/google/uuid"
)

// FileCloner is the storage half of forwarding a file (WP 6.9a): Clone gives a
// stored file a second name, by hard link where the volume allows it. Delete
// takes a clone back out when the forward that wanted it fails.
// *storage.Storage satisfies it.
type FileCloner interface {
	Clone(ctx context.Context, src, dst string) error
	Delete(name string) error
}

// SetFileCloner installs the storage that forwarded files are cloned in. The
// composition root does it beside the other storage installs; until then a
// forward that carries files is refused (ErrInternal) and a text-only forward
// works.
func (s *UploadService) SetFileCloner(c FileCloner) {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	s.cloner = c
}

func (s *UploadService) fileCloner() FileCloner {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	return s.cloner
}

// ClonedFiles is the set of unlinked attachment rows a forward owns until it
// commits. IDs are in the source's upload order, minus any file whose bytes
// were already gone.
type ClonedFiles struct {
	IDs []string
	up  *UploadService
	uid int64
}

// Discard takes the clones back out after a forward that did not commit:
// deletes the still-unlinked rows, returns their bytes to the user's counter
// and removes the files. Best effort and safe on a cancelled ctx; whatever it
// cannot reach the orphan sweep reclaims, because the rows are unlinked.
func (c *ClonedFiles) Discard(ctx context.Context) {
	if c == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	cloner := c.up.fileCloner()
	for _, id := range c.IDs {
		// Only a row this call removed gives up its bytes: a linked or
		// unreachable row keeps the file it names.
		removed, err := c.up.Discard(ctx, id, c.uid)
		if err != nil && !errors.Is(err, ErrNotFound) {
			slog.Warn("forward: could not remove an unused clone row; the orphan sweep will", "file_id", id, "err", err)
		}
		if removed == "" {
			continue
		}
		if cloner == nil {
			continue
		}
		if err := cloner.Delete(id); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("forward: could not remove an unused clone file; the orphan sweep will", "file_id", id, "err", err)
		}
	}
	c.IDs = nil
}

// CloneAttachments gives userID their own copy of each of src for a forward.
// Every copy is charged to userID through Reserve (the counter is recounted
// from rows by uploader, so the charge must land on the forwarder), cloned on
// disk, and recorded as an unlinked row with the forwarder as uploader. The
// forward's transaction then links them through the ordinary send path.
//
// A file whose bytes are already gone (swept after its message was deleted) is
// skipped, as a send skips a missing upload. Any other failure, a quota
// refusal included, discards the copies made so far and returns the error.
func (s *UploadService) CloneAttachments(ctx context.Context, userID int64, src []db.ForwardAttachment) (*ClonedFiles, error) {
	out := &ClonedFiles{up: s, uid: userID}
	if len(src) == 0 {
		return out, nil
	}
	cloner := s.fileCloner()
	if cloner == nil {
		return nil, fmt.Errorf("%w: file storage is not available for forwarding", ErrInternal)
	}
	for i := range src {
		if err := s.cloneOne(ctx, cloner, userID, &src[i], out); err != nil {
			out.Discard(ctx)
			return nil, err
		}
	}
	return out, nil
}

func (s *UploadService) cloneOne(ctx context.Context, cloner FileCloner, userID int64, a *db.ForwardAttachment, out *ClonedFiles) error {
	res, err := s.Reserve(ctx, userID, a.Size)
	if err != nil {
		return quotaRefusal(err)
	}
	defer res.Settle(ctx)
	newID := uuid.NewString()
	if err := cloner.Clone(ctx, a.StoredAs, newID); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("%w: clone attachment: %w", ErrInternal, err)
	}
	res.Landed()
	rec := AttachmentRecord{
		ID: newID, UploaderID: userID, Filename: a.Filename, MimeType: a.Mime,
		Size: a.Size, Width: a.Width, Height: a.Height,
		DurationMs: a.DurationMs, Waveform: a.Waveform,
	}
	if err := s.Record(ctx, rec, res); err != nil {
		if delErr := cloner.Delete(newID); delErr != nil && !errors.Is(delErr, fs.ErrNotExist) {
			slog.Warn("forward: could not remove a clone whose row failed; the reconciliation pass will", "file_id", newID, "err", delErr)
		}
		return err
	}
	out.IDs = append(out.IDs, newID)
	return nil
}

// quotaRefusal turns a Reserve refusal into a service error the WS layer
// answers with a message the sender can act on. Anything else is internal.
func quotaRefusal(err error) error {
	switch {
	case errors.Is(err, ErrQuotaExceeded), errors.Is(err, ErrLowDisk):
		return fmt.Errorf("%w: %w", ErrForbidden, err)
	default:
		return err
	}
}
