package api

import (
	"image"
	"log/slog"
	"strings"
)

// inspectStoredImage looks at the file just stored as fileID: a TIFF-structured
// camera RAW is demoted to application/octet-stream (a download, not a
// picture), and an image gets its upright width and height.
func inspectStoredImage(store FileStore, fileID, mime string) (outMime string, width, height *int) {
	// A TIFF-structured camera RAW is a download, not a picture.
	if mime == mimeTIFF {
		if f, openErr := store.Open(fileID); openErr == nil {
			if isCameraRAW(withReadAt(f)) {
				mime = "application/octet-stream"
			}
			f.Close() //nolint:errcheck
		}
	}

	// Extract image dimensions if the file is an image.
	if strings.HasPrefix(mime, "image/") {
		f, openErr := store.Open(fileID)
		if openErr == nil {
			var cfg image.Config
			var decErr error
			if convertedFormat(mime) != "" {
				cfg, decErr = convertedConfig(f, mime)
			} else {
				cfg, _, decErr = image.DecodeConfig(f)
			}
			if decErr == nil && mime == "image/jpeg" && jpegSidewaysOnDisk(f) {
				cfg.Width, cfg.Height = cfg.Height, cfg.Width
			}
			if decErr == nil && convertedFormat(mime) != "" && convertedUprightSwap(f, mime) {
				cfg.Width, cfg.Height = cfg.Height, cfg.Width
			}
			f.Close() //nolint:errcheck
			if decErr == nil {
				w2, h2 := cfg.Width, cfg.Height
				width = &w2
				height = &h2
			} else {
				slog.Warn("failed to decode image dimensions", "id", fileID, "error", decErr)
			}
		}
	}

	return mime, width, height
}
