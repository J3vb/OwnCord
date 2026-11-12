package api

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/google/uuid"
)

// allowedAvatarMIME is the set of still image types an avatar, banner or group
// icon may be, matched against the type sniffed from the file's own bytes. GIF
// is added per surface (imageLimits.AllowGIF), where the client freezes it to
// its first frame until hovered. SVG is absent, as for emoji: it is markup with
// script and external-fetch capability, and an avatar is rendered inline.
var allowedAvatarMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
}

// handleUploadAvatar processes POST /api/v1/users/me/avatar (multipart: `file`).
// The bytes land in the attachments table with no channel and the avatar column
// points at /api/v1/files/{id}. An unlinked attachment is private to its
// uploader and handleServeFile also admits one some user's avatar points at, so
// an avatar is readable exactly while in use. PATCH /users/me still takes an
// https:// URL; both end at the same column.
func handleUploadAvatar(
	svc *service.Services,
	store FileStore,
	limiter *auth.RateLimiter,
	broadcaster ProfileBroadcaster,
) http.HandlerFunc {
	slots := newUploadSlots(maxConcurrentImageUploadsPerUser)
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		if limiter != nil && !limiter.Allow(auth.Key("avatar_upload", user.ID), avatarUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "avatar upload rate limit exceeded, try again later")
			return
		}
		if !slots.acquire(user.ID) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "avatar upload already in progress, wait for it to finish")
			return
		}
		defer slots.release(user.ID)

		// Bound the body before the multipart parser: the route has MaxBodySize
		// too, but the parser is what turns an unbounded body into heap. The
		// global 30 s ReadTimeout would cut a slow uplink mid-body, so the read
		// runs under a transfer deadline instead.
		release := transferBody(w, r, avatarMaxBodySize)
		defer release()
		raw, filename, mimeType, width, height, ok := readProfileImageForm(w, r, avatarMultipartMemoryLimit, "avatar upload", avatarImageLimits)
		if !ok {
			return
		}
		fileID, written, ok := avatarStoreAndRecord(r.Context(), w, svc, store, user.ID, filename, raw, mimeType, "avatar", width, height)
		if !ok {
			return
		}

		avatarURL := service.AvatarFileURL(fileID)
		// Username is deliberately omitted: user is a snapshot AuthMiddleware
		// read before the multipart parse, image decode and disk write, long
		// enough for a concurrent PATCH /users/me rename to land first, and
		// sending the stale value would revert it. UpdateProfile treats an empty
		// Username as "leave it alone", like nil DisplayName/About.
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Avatar: &avatarURL,
		})
		if err != nil {
			// The column never moved, so the file and its row are orphans; drop
			// the row now so its charge does not wait for the sweep.
			if unErr := svc.Uploads.Unrecord(context.WithoutCancel(r.Context()), fileID, user.ID); unErr != nil {
				slog.Error("failed to remove orphaned avatar row", "stored_as", fileID, "error", unErr)
			}
			if delErr := store.Delete(fileID); delErr != nil {
				slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
			}
			writeServiceError(r.Context(), w, err)
			return
		}

		// The previous avatar's bytes stay on disk on purpose: a message
		// rendered with it may still be cached client-side, and a delete here
		// would race in-flight requests. Reclaiming them is an operator-side
		// sweep.
		broadcastUserUpdate(broadcaster, updated)

		slog.Info("avatar uploaded", "user_id", user.ID, "id", fileID, "size", written, "mime", mimeType)
		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: filename,
			Size:     written,
			Mime:     mimeType,
			URL:      avatarURL,
			Width:    &width,
			Height:   &height,
		})
	}
}

// avatarStoreAndRecord is the store-and-row stage of handleUploadAvatar: admit
// the bytes (an avatar counts against its uploader's quota), write them, and
// record the row that commits the charge. It writes its own error response and
// reports ok=false.
func avatarStoreAndRecord(ctx context.Context, w http.ResponseWriter, svc *service.Services, store FileStore, userID int64, filename string, raw []byte, mimeType, label string, width, height int) (string, int64, bool) {
	res, err := svc.Uploads.Reserve(ctx, userID, int64(len(raw)))
	if err != nil {
		writeStorageSaveError(w, err, label+" upload")
		return "", 0, false
	}
	defer res.Settle(ctx)

	fileID := uuid.New().String()
	written, saveErr := saveReserved(ctx, res, store, fileID, bytes.NewReader(raw))
	if saveErr != nil {
		writeStorageSaveError(w, saveErr, label+" upload")
		return "", 0, false
	}

	if err := svc.Uploads.Record(ctx, service.AttachmentRecord{
		ID:         fileID,
		UploaderID: userID,
		Filename:   filename,
		MimeType:   mimeType,
		Size:       written,
		Width:      &width,
		Height:     &height,
	}, res); err != nil {
		if delErr := store.Delete(fileID); delErr != nil {
			slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
		}
		slog.Error("failed to create avatar attachment record", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to save "+label)
		return "", 0, false
	}
	return fileID, written, true
}
