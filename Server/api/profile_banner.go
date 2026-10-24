package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// handleUploadBanner processes POST /api/v1/users/me/banner (multipart: `file`).
//
// It is the avatar upload with the banner limits: the bytes land in the
// attachments table with no channel, and users.banner_id names the attachment.
// The file is public exactly while banner_id names it (service/upload.go,
// UploadService.isLiveBanner), and the orphan sweep reclaims it once replaced.
// PATCH /users/me never accepts a banner id or URL, so an image can only come
// from an upload to this server.
func handleUploadBanner(
	svc *service.Services,
	store FileStore,
	limiter *auth.RateLimiter,
	broadcaster ProfileBroadcaster,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		if limiter != nil && !limiter.Allow(auth.Key("banner_upload", user.ID), bannerUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "banner upload rate limit exceeded, try again later")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, bannerMaxBodySize)
		if err := r.ParseMultipartForm(bannerMultipartMemoryLimit); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid multipart form")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "missing file field")
			return
		}
		defer file.Close() //nolint:errcheck

		raw, mimeType, width, height, ok := readProfileImage(w, file, bannerImageLimits)
		if !ok {
			return
		}

		filename := sanitizeUploadFilename(header.Filename)
		fileID, written, ok := avatarStoreAndRecord(r.Context(), w, svc, store, user.ID, filename, raw, mimeType, "banner", width, height)
		if !ok {
			return
		}

		// Username is left empty on purpose, as in handleUploadAvatar: user is
		// a snapshot from before the multipart parse and image decode, and a
		// rename that landed meanwhile must not be reverted. UpdateProfile
		// merges the banner under the per-user lock.
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			BannerID: &fileID,
		})
		if err != nil {
			// The column never moved, so the file and its row are orphans.
			discardBannerUpload(r.Context(), svc, store, fileID, user.ID)
			writeServiceError(r.Context(), w, err)
			return
		}

		// The previous banner stops being readable now (banner_id no longer
		// names it) and the orphan sweep reclaims its bytes.
		broadcastUserUpdate(broadcaster, updated)

		slog.Info("banner uploaded", "user_id", user.ID, "id", fileID, "size", written, "mime", mimeType)
		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: filename,
			Size:     written,
			Mime:     mimeType,
			URL:      service.AvatarFileURL(fileID),
			Width:    &width,
			Height:   &height,
		})
	}
}

// discardBannerUpload removes an uploaded banner whose profile write failed:
// the row first, so its quota charge does not wait for the sweep, then the bytes.
func discardBannerUpload(ctx context.Context, svc *service.Services, store FileStore, fileID string, userID int64) {
	ctx = context.WithoutCancel(ctx)
	if err := svc.Uploads.Unrecord(ctx, fileID, userID); err != nil {
		slog.Error("failed to remove orphaned banner row", "stored_as", fileID, "error", err)
	}
	if err := store.Delete(fileID); err != nil {
		slog.Error("failed to clean up orphaned banner file", "stored_as", fileID, "error", err)
	}
}

// handleDeleteBanner serves DELETE /api/v1/users/me/banner: clear the caller's
// banner image. The colour is separate (PATCH banner_color ""). The broadcast
// carries banner null. Clearing an unset banner is a no-op write.
func handleDeleteBanner(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		cleared := ""
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{BannerID: &cleared})
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		broadcastUserUpdate(broadcaster, updated)
		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}
