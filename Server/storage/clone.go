package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
)

// linkFile is os.Link, a variable so a test can make the hard link fail and
// reach the copy fallback, which no ordinary temporary directory refuses.
var linkFile = os.Link

// ErrCloneExists reports that the destination name is already taken. Clone
// never overwrites: a forwarded attachment gets a fresh uuid, so a collision
// means a caller bug, not something to paper over.
var ErrCloneExists = errors.New("storage clone destination exists")

// Clone makes the stored file named dst a second name for the bytes of src,
// for a forwarded attachment: the forward owns its own file, so deleting either
// message never takes the other's bytes with it.
//
// It hard-links first (no extra disk) and falls back to a ctx-aware stream
// copy where the filesystem refuses a link. The bytes were validated when src
// was saved, so no magic-byte check runs again. A missing src is
// fs.ErrNotExist. Any failure leaves no dst behind.
func (s *Storage) Clone(ctx context.Context, src, dst string) error {
	if err := sanitizeFilename(src); err != nil {
		return err
	}
	if err := sanitizeFilename(dst); err != nil {
		return err
	}
	srcPath, err := s.resolvedPath(src)
	if err != nil {
		return err
	}
	dstPath, err := s.resolvedPath(dst)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("clone %s: %w", src, err)
	}
	linkErr := linkFile(srcPath, dstPath)
	if linkErr == nil {
		return nil
	}
	if errors.Is(linkErr, fs.ErrNotExist) {
		return fmt.Errorf("clone %s: %w", src, linkErr)
	}
	if errors.Is(linkErr, fs.ErrExist) {
		return fmt.Errorf("%w: %s", ErrCloneExists, dst)
	}
	return s.copyFile(ctx, srcPath, dstPath, linkErr)
}

// copyFile is Clone's fallback when a hard link is refused. linkErr is only
// logged; the copy decides the outcome.
func (s *Storage) copyFile(ctx context.Context, srcPath, dstPath string, linkErr error) (err error) {
	slog.Debug("storage: hard link refused, copying instead", "err", linkErr)
	in, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("opening clone source: %w", err)
	}
	defer func() { _ = in.Close() }()
	// O_EXCL: never write through an existing name.
	out, err := os.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w: %s", ErrCloneExists, dstPath)
		}
		return fmt.Errorf("creating clone: %w: %w", ErrIO, err)
	}
	// Any failure after the create removes the partial file: the orphan sweep
	// is row-driven, so a file with no row is never reclaimed.
	success := false
	defer func() {
		closeErr := out.Close()
		if success && closeErr != nil {
			success = false
			err = fmt.Errorf("closing clone: %w: %w", ErrIO, closeErr)
		}
		if !success {
			if rmErr := os.Remove(dstPath); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
				slog.Error("storage: failed to remove partial clone", "path", dstPath, "err", rmErr)
			}
		}
	}()
	if _, err := io.Copy(out, ctxReader{ctx: ctx, r: in}); err != nil {
		if _, ok := errors.AsType[*fs.PathError](err); ok {
			return fmt.Errorf("copying clone: %w: %w", ErrIO, err)
		}
		return fmt.Errorf("copying clone: %w", err)
	}
	if err := out.Sync(); err != nil {
		return fmt.Errorf("syncing clone: %w: %w", ErrIO, err)
	}
	success = true
	return nil
}

// ctxReader stops a copy between reads once ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, fmt.Errorf("copy interrupted: %w", err)
	}
	// io.Copy compares against io.EOF directly, so the reader's error passes
	// through unwrapped.
	return c.r.Read(p)
}
