package discordimport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // registers the GIF header decoder for imageSize
	_ "image/png" // registers the PNG header decoder for imageSize
	"io"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/J3vb/OwnCord/Server/storage"
)

// copyAttachment stores one local file as an unlinked attachment of the import
// account. It returns "" for a skipped file and an error only for a failure that
// should stop the import.
func (r *Runner) copyAttachment(ctx context.Context, ex Export, st *runState, a *Attachment) (string, error) {
	media, err := ex.OpenMedia(a.URL)
	if errors.Is(err, ErrRemoteMedia) || errors.Is(err, ErrMediaMissing) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("opening attachment: %w", err)
	}
	defer media.Reader.Close() //nolint:errcheck

	name := cleanFilename(a.FileName, a.URL)
	if st.policy.Check(name) != nil {
		return "", nil
	}
	size := media.Size
	if size <= 0 {
		size = a.FileSizeBytes
	}
	if st.maxFile > 0 && size > st.maxFile {
		return "", nil
	}
	res, err := r.cfg.Uploads.ReserveHeadroom(ctx, max(size, 0))
	if err != nil {
		// Low disk would only get worse, so it ends the import rather than
		// dropping files one by one.
		return "", fmt.Errorf("reserving space: %w", err)
	}
	defer res.Settle(ctx)

	var sniff [512]byte
	n, rerr := io.ReadFull(media.Reader, sniff[:])
	if rerr != nil && !errors.Is(rerr, io.EOF) && !errors.Is(rerr, io.ErrUnexpectedEOF) {
		return "", fmt.Errorf("reading attachment: %w", rerr)
	}
	mime := http.DetectContentType(sniff[:n])
	fileID := uuid.New().String()
	width, height := imageSize(sniff[:n], mime)
	written, err := r.cfg.Files.SaveReserved(ctx, res, fileID, io.MultiReader(bytes.NewReader(sniff[:n]), media.Reader))
	if err != nil {
		if errors.Is(err, storage.ErrIO) || errors.Is(err, ErrZipTooLarge) {
			return "", fmt.Errorf("storing attachment: %w", err)
		}
		return "", nil
	}
	if err := r.cfg.Store.CreateAttachment(ctx, fileID, st.account, name, fileID, mime, written, width, height); err != nil {
		if delErr := r.cfg.Files.Delete(fileID); delErr != nil {
			slog.Warn("failed to remove import file", "stored_as", fileID, "error", delErr)
		}
		return "", fmt.Errorf("recording attachment: %w", err)
	}
	res.Commit()
	if st.chunkBytes == 0 {
		st.chunkSince = r.now()
	}
	st.chunkBytes += max(written, 1)
	return fileID, nil
}

// imageSize reads the size of a PNG or GIF from its first bytes, where the
// header lives. A JPEG is left unmeasured: its size sits after the metadata
// and its EXIF orientation can swap the sides, which this cheap pass cannot
// settle, so clients size it once it loads.
func imageSize(head []byte, mime string) (width, height *int) {
	if mime != "image/png" && mime != "image/gif" {
		return nil, nil
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(head))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, nil
	}
	return &cfg.Width, &cfg.Height
}

// cleanFilename is the display name an attachment keeps: the export's file name
// (else the last part of its path) with directory parts, control and invisible
// characters removed, cut to fit.
func cleanFilename(name, ref string) string {
	if strings.TrimSpace(name) == "" {
		name = ref
	}
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	var sb strings.Builder
	for _, r := range name {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) || r == '/' {
			continue
		}
		sb.WriteRune(r)
	}
	name = strings.TrimSpace(sb.String())
	if len(name) > maxFilenameBytes {
		name = strings.ToValidUTF8(name[:maxFilenameBytes], "")
	}
	if name == "" || name == "." || name == ".." || name == "/" {
		return "unnamed"
	}
	return name
}
