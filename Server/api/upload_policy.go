package api

import (
	"context"
	"log/slog"
	"math"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// uploadBodyCap is the request body cap for one upload given the per-file
// cap in bytes (upload.max_size_mb; 0 when unset, or when a max_size_mb of 0
// disables uploads and storage.Save refuses every non-empty file). It never
// drops below uploadMaxBodySize, so a file over a smaller per-file cap still
// reaches storage.Save and its own size rejection; above that it is the
// per-file cap plus the multipart margin, saturating rather than overflowing.
func uploadBodyCap(fileCap int64) int64 {
	if fileCap > math.MaxInt64-uploadMultipartMargin {
		return math.MaxInt64
	}
	return max(uploadMaxBodySize, fileCap+uploadMultipartMargin)
}

// checkUploadFileType refuses filename under the upload file-type policy with
// the storage blocked-file-type refusal, reporting whether the upload may go
// on. A policy that cannot be read fails closed.
func checkUploadFileType(ctx context.Context, w http.ResponseWriter, uploads *service.UploadService, filename string) bool {
	policy, err := uploads.FileTypePolicy(ctx)
	if err != nil {
		slog.Error("upload refused: reading the file-type policy failed", "error", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to read the upload policy")
		return false
	}
	if err := policy.Check(filename); err != nil {
		writeStorageSaveError(w, err, "file upload")
		return false
	}
	return true
}
