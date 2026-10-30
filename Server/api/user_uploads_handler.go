package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// UploadRemovalBroadcaster tells a message's readers that its author removed one
// of its files; satisfied by *ws.Hub.
type UploadRemovalBroadcaster interface {
	// AttachmentsChanged sends the message with its remaining files as a chat_edited.
	AttachmentsChanged(ctx context.Context, res *service.AttachmentsChangedResult)
	// MessageDeletedByUpload sends the chat_deleted of a message left empty.
	MessageDeletedByUpload(ctx context.Context, res *service.DeleteMessageResult)
}

// MountUserUploadRoutes registers the signed-in user's storage figure, the list
// of files they uploaded and the removal of one. All three share the uploads
// rate-limit bucket. store may be nil (the server could not open its upload
// directory): a removal then drops the row and leaves the bytes. broadcaster may
// be nil, in which case a removal still commits but readers are not told.
func MountUserUploadRoutes(r chi.Router, svc *service.Services, store FileStore, limiter *auth.RateLimiter, trustedProxies []string, broadcaster UploadRemovalBroadcaster) {
	gated := r.With(
		AuthMiddleware(svc.Sessions),
		RateLimitMiddleware(limiter, "uploads:", ownUploadsRateLimitPerMinute, time.Minute, trustedProxies),
	)
	gated.Get("/api/v1/users/me/storage", handleOwnStorage(svc))
	gated.Get("/api/v1/users/me/uploads", handleListOwnUploads(svc))
	gated.Delete("/api/v1/users/me/uploads/{id}", handleRemoveOwnUpload(svc, store, broadcaster))
}

func handleOwnStorage(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		sum, err := svc.Uploads.StorageSummary(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, sum)
	}
}

func handleListOwnUploads(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		q := r.URL.Query()
		in := service.OwnUploadsRequest{Sort: q.Get("sort"), Name: q.Get("q"), Cursor: q.Get("cursor")}
		if raw := q.Get("limit"); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "limit must be a positive integer")
				return
			}
			in.Limit = v
		}
		page, err := svc.Uploads.ListOwnUploads(r.Context(), user.ID, in)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

// handleRemoveOwnUpload deletes one of the caller's files, wherever it sits, and
// returns its bytes to their quota. Unknown, someone else's and already removed
// are all a 404; a live avatar, banner or group icon is a 409. Once the row is
// gone the bytes are deleted and the message that held the file is announced; a
// failure in either is logged, not turned into an error, since the removal itself
// has committed.
func handleRemoveOwnUpload(svc *service.Services, store FileStore, broadcaster UploadRemovalBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		removed, err := svc.Uploads.RemoveOwnUpload(r.Context(), chi.URLParam(r, "id"), user.ID)
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "upload not found")
			return
		}
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// The row is committed: what follows must survive a client that hangs up.
		ctx := context.WithoutCancel(r.Context())
		deleteRemovedFile(ctx, svc.Uploads, store, removed.StoredAs)
		if removed.MessageID != nil {
			announceRemoval(ctx, svc, broadcaster, user.ID, *removed.MessageID)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// deleteRemovedFile deletes the bytes of a removed row unless another row still
// names them, or the lookup that would tell failed (the bytes stay, the safe side).
func deleteRemovedFile(ctx context.Context, uploads *service.UploadService, store FileStore, storedAs string) {
	if store == nil || storedAs == "" {
		return
	}
	shared, err := uploads.StoredFileShared(ctx, storedAs)
	if err != nil {
		slog.ErrorContext(ctx, "failed to check removed upload file", "stored_as", storedAs, "error", err)
		return
	}
	if shared {
		return
	}
	if delErr := store.Delete(storedAs); delErr != nil {
		slog.ErrorContext(ctx, "failed to delete removed upload", "stored_as", storedAs, "error", delErr)
	}
}

// announceRemoval tells the readers of the message that held the removed file.
func announceRemoval(ctx context.Context, svc *service.Services, broadcaster UploadRemovalBroadcaster, userID, msgID int64) {
	changed, deleted, err := svc.Messages.AfterAttachmentRemoved(ctx, userID, msgID)
	if err != nil {
		slog.ErrorContext(ctx, "failed to announce removed upload", "message_id", msgID, "error", err)
		return
	}
	if broadcaster == nil {
		return
	}
	switch {
	case deleted != nil:
		broadcaster.MessageDeletedByUpload(ctx, deleted)
	case changed != nil:
		broadcaster.AttachmentsChanged(ctx, changed)
	}
}
