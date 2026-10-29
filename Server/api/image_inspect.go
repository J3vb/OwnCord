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
	if mime == mimeTIFF && storedCameraRAW(store, fileID) {
		mime = "application/octet-stream"
	}
	if !strings.HasPrefix(mime, "image/") {
		return mime, nil, nil
	}
	width, height = storedImageSize(store, fileID, mime)
	return mime, width, height
}

// storedCameraRAW reports whether the stored TIFF-structured file is a camera RAW.
func storedCameraRAW(store FileStore, fileID string) bool {
	f, err := store.Open(fileID)
	if err != nil {
		return false
	}
	defer f.Close() //nolint:errcheck
	return isCameraRAW(withReadAt(f))
}

// storedImageSize is the upright size of the stored image, or nil when it
// cannot be read.
func storedImageSize(store FileStore, fileID, mime string) (width, height *int) {
	f, err := store.Open(fileID)
	if err != nil {
		return nil, nil
	}
	defer f.Close() //nolint:errcheck
	var cfg image.Config
	if convertedFormat(mime) != "" {
		cfg, err = convertedSize(f, mime)
	} else {
		cfg, _, err = image.DecodeConfig(f)
	}
	if err != nil {
		slog.Warn("failed to decode image dimensions", "id", fileID, "error", err)
		return nil, nil
	}
	if mime == "image/jpeg" && jpegSidewaysOnDisk(f) {
		cfg.Width, cfg.Height = cfg.Height, cfg.Width
	}
	w, h := cfg.Width, cfg.Height
	return &w, &h
}
