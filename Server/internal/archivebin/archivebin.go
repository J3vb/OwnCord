// Package archivebin pulls one named executable out of a downloaded release
// archive, for the updater and the LiveKit download. Only a regular file is taken (never a link or folder);
// a name containing ".." is skipped; the first match is written O_EXCL with mode 0600; the entry must be
// <= maxBytes and exactly its header's size. A file this package created is removed again when the write
// fails.
package archivebin

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// ErrNoEntry means the archive holds no regular file the match accepts.
var ErrNoEntry = errors.New("archive holds no matching binary")

// ErrTooLarge means the matching entry is larger than maxBytes.
var ErrTooLarge = errors.New("archive entry is larger than allowed")

// Match reports whether an entry name is the binary wanted.
type Match func(name string) bool

// FromTarGz extracts the first matching regular entry of a tar.gz stream to
// destPath and returns the hex sha256 of the bytes written.
func FromTarGz(r io.Reader, destPath string, match Match, maxBytes int64) (string, error) {
	gr, err := gzip.NewReader(r)
	if err != nil {
		return "", fmt.Errorf("gzip: %w", err)
	}
	defer func() { _ = gr.Close() }()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return "", ErrNoEntry
		}
		if err != nil {
			return "", fmt.Errorf("tar: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || !wanted(hdr.Name, match) {
			continue
		}
		sum, err := write(destPath, tr, hdr.Size, maxBytes)
		return sum, err
	}
}

// FromZip is FromTarGz for a zip.
func FromZip(r io.ReaderAt, size int64, destPath string, match Match, maxBytes int64) (string, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return "", fmt.Errorf("zip: %w", err)
	}
	for _, entry := range zr.File {
		if !entry.Mode().IsRegular() || !wanted(entry.Name, match) {
			continue
		}
		if entry.UncompressedSize64 > uint64(max(maxBytes, 0)) {
			return "", fmt.Errorf("%w: %d bytes, the limit is %d", ErrTooLarge, entry.UncompressedSize64, maxBytes)
		}
		rc, err := entry.Open()
		if err != nil {
			return "", fmt.Errorf("opening zip entry: %w", err)
		}
		sum, err := write(destPath, rc, int64(entry.UncompressedSize64), maxBytes) //nolint:gosec // G115: checked against maxBytes above
		_ = rc.Close()
		return sum, err
	}
	return "", ErrNoEntry
}

func wanted(name string, match Match) bool {
	return !strings.Contains(name, "..") && match(name)
}

func write(destPath string, r io.Reader, size, maxBytes int64) (string, error) {
	if size < 0 || size > maxBytes {
		return "", fmt.Errorf("%w: %d bytes, the limit is %d", ErrTooLarge, size, maxBytes)
	}
	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600) //nolint:gosec // G304: the caller's staging path
	if err != nil {
		return "", fmt.Errorf("creating %s: %w", destPath, err)
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(r, size+1))
	closeErr := out.Close()
	switch {
	case copyErr != nil:
		err = fmt.Errorf("writing binary: %w", copyErr)
	case closeErr != nil:
		err = fmt.Errorf("closing binary: %w", closeErr)
	case n != size:
		err = fmt.Errorf("archive entry gave %d bytes, its header says %d", n, size)
	}
	if err != nil {
		_ = os.Remove(destPath)
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
