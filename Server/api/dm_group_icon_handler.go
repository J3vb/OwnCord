package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// Group DM icon routes. The upload follows the avatar rules
// (handleUploadAvatar): the same size, type and dimension checks, the same
// storage quota, stored as an unlinked attachment. What differs is where the
// id lands (channels.dm_icon, with a group_icon row in the same transaction)
// and who may read it (the group's members, while it is the live icon).

// handleUploadGroupIcon processes POST /api/v1/dms/{channelId}/icon
// (multipart: `file`). Any member may set the icon of a group DM.
func handleUploadGroupIcon(svc *service.Services, broadcaster DMBroadcaster, store FileStore, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}
		if limiter != nil && !limiter.Allow(auth.Key("dm_icon_upload", user.ID), avatarUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "icon upload rate limit exceeded, try again later")
			return
		}
		// Membership, group-ness and timeout are decided before any byte is
		// read or stored, so a non-member or a 1:1 costs nothing.
		if err := svc.DMs.AuthorizeGroupIcon(r.Context(), user.ID, channelID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, avatarMaxBodySize)
		if err := r.ParseMultipartForm(avatarMultipartMemoryLimit); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "missing file field")
			return
		}
		defer file.Close() //nolint:errcheck

		raw, mimeType, width, height, ok := readProfileImage(w, file, groupIconImageLimits)
		if !ok {
			return
		}
		fileID, written, ok := avatarStoreAndRecord(r.Context(), w, svc, store, user.ID, sanitizeUploadFilename(header.Filename), raw, mimeType, "avatar", width, height)
		if !ok {
			return
		}

		change, err := svc.DMs.SetGroupIcon(r.Context(), user.ID, channelID, &fileID)
		if err != nil {
			// Nothing was written: the file and its row are orphans. Drop the
			// row so its charge does not wait for the sweep, and the bytes.
			discardGroupIconUpload(r.Context(), svc, store, fileID, user.ID)
			writeServiceError(r.Context(), w, err)
			return
		}
		fanOutGroupChange(r.Context(), svc, broadcaster, channelID, change.Audience, change.Rows)
		slog.Info("group icon uploaded", "user_id", user.ID, "channel_id", channelID, "id", fileID, "size", written, "mime", mimeType)
		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}

// discardGroupIconUpload removes an uploaded icon whose transaction failed.
func discardGroupIconUpload(ctx context.Context, svc *service.Services, store FileStore, fileID string, userID int64) {
	ctx = context.WithoutCancel(ctx)
	if err := svc.Uploads.Unrecord(ctx, fileID, userID); err != nil {
		slog.Error("failed to remove orphaned group icon row", "stored_as", fileID, "error", err)
	}
	if err := store.Delete(fileID); err != nil {
		slog.Error("failed to clean up orphaned group icon file", "stored_as", fileID, "error", err)
	}
}

// handleDeleteGroupIcon processes DELETE /api/v1/dms/{channelId}/icon. Any
// member may clear the icon. A group with no icon changes nothing: no row and
// no event.
func handleDeleteGroupIcon(svc *service.Services, broadcaster DMBroadcaster, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		channelID, ok := parseIDParam(w, r, "channelId")
		if !ok {
			return
		}
		if !allowGroupMutation(w, limiter, user.ID) {
			return
		}
		if err := svc.DMs.AuthorizeGroupIcon(r.Context(), user.ID, channelID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		change, err := svc.DMs.SetGroupIcon(r.Context(), user.ID, channelID, nil)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if len(change.Rows) > 0 {
			fanOutGroupChange(r.Context(), svc, broadcaster, channelID, change.Audience, change.Rows)
		}
		writeGroupSummary(w, r, svc, user.ID, channelID)
	}
}
