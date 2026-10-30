package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// StickerBroadcaster is the slice of the hub the sticker routes need: after
// every mutation the full set is pushed to every client so pickers converge
// without a reconnect.
type StickerBroadcaster interface {
	BroadcastStickerUpdate(list []*service.Sticker)
}

// stickerResponse is one sticker in the sticker routes. Deliberately not
// service.Sticker: the storage id and sniffed mime type are server-side details.
type stickerResponse struct {
	ID    int64   `json:"id"`
	Name  string  `json:"name"`
	Emoji *string `json:"emoji"`
	URL   string  `json:"url"`
}

func toStickerResponse(s *service.Sticker) stickerResponse {
	return stickerResponse{ID: s.ID, Name: s.Name, Emoji: s.Emoji, URL: service.StickerImageURL(s.ID)}
}

func toStickerResponses(list []*service.Sticker) []stickerResponse {
	out := make([]stickerResponse, 0, len(list))
	for _, s := range list {
		if s == nil {
			continue
		}
		out = append(out, toStickerResponse(s))
	}
	return out
}

// allowedStickerMIME is the set of image types a sticker may be, matched against
// the type sniffed from the bytes. Animated GIF and WebP are allowed; JPEG is
// absent (a sticker needs transparency) and so is SVG, which is script-capable
// markup that cannot be served inline.
var allowedStickerMIME = map[string]bool{
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// MountStickerRoutes registers the custom-sticker endpoints; every route needs
// authentication. Reading is otherwise ungated (stickers are server-wide) while
// POST, PATCH and DELETE are gated on MANAGE_SERVER inside StickerService. The
// image route is authenticated so a sticker cannot be an unauthenticated
// tracking pixel.
func MountStickerRoutes(r chi.Router, svc *service.Services, store FileStore, limiter *auth.RateLimiter, broadcaster StickerBroadcaster) {
	r.Route("/api/v1/stickers", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListStickers(svc))
		r.Get("/{id}/image", handleServeStickerImage(svc, store))
		r.With(MaxBodySize(stickerMaxBodySize)).
			Post("/", handleCreateSticker(svc, store, limiter, broadcaster))
		r.With(MaxBodySize(stickerPatchMaxBodySize)).
			Patch("/{id}", handleUpdateSticker(svc, broadcaster))
		r.Delete("/{id}", handleDeleteSticker(svc, store, broadcaster))
	})
}

func stickerIDParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, ok := pathID(r, "id")
	if !ok {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid sticker id")
		return 0, false
	}
	return id, true
}

func handleListStickers(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.Stickers.List(r.Context())
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, toStickerResponses(list))
	}
}

// handleCreateSticker processes POST /api/v1/stickers (multipart: `file`,
// `name`, optional `emoji`). Order matters, as for emoji: the permission gate
// runs BEFORE the multipart parse so a member without MANAGE_SERVER cannot make
// the server spool a body to disk; name and emoji are validated next; only then
// are the bytes read, sniffed, measured and stored.
func handleCreateSticker(svc *service.Services, store FileStore, limiter *auth.RateLimiter, broadcaster StickerBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		if err := svc.Stickers.RequireManage(r.Context(), user.ID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if limiter != nil && !limiter.Allow(auth.Key("sticker_upload", user.ID), stickerUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "sticker upload rate limit exceeded, try again later")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, stickerMaxBodySize)
		if err := r.ParseMultipartForm(stickerMultipartMemoryLimit); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}

		name, err := service.ValidateStickerName(r.FormValue("name"))
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if _, err := service.ValidateStickerEmoji(r.FormValue("emoji")); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		raw, mimeType, readOK := readStickerUpload(w, r)
		if !readOK {
			return
		}

		// Like emoji, stickers are a bounded exclusion from the per-user quota
		// (server-wide asset that changes owner on erasure, MANAGE_SERVER-gated,
		// capped at service.MaxStickerCount files of maxStickerFileBytes) but
		// not from the headroom floor: a full disk is full for everyone.
		res, err := svc.Uploads.ReserveHeadroom(r.Context(), int64(len(raw)))
		if err != nil {
			writeStorageSaveError(w, err, "sticker upload")
			return
		}
		defer res.Settle(r.Context())

		storedAs := uuid.New().String()
		if _, saveErr := saveReserved(r.Context(), res, store, storedAs, bytes.NewReader(raw)); saveErr != nil {
			writeStorageSaveError(w, saveErr, "sticker upload")
			return
		}

		created, err := svc.Stickers.Create(r.Context(), user.ID, name, r.FormValue("emoji"), storedAs, mimeType)
		if err != nil {
			// The row never landed (a name clash included), so the file is an
			// orphan; unlink it.
			if delErr := store.Delete(storedAs); delErr != nil {
				slog.Error("failed to clean up orphaned sticker file", "stored_as", storedAs, "error", delErr)
			}
			writeServiceError(r.Context(), w, err)
			return
		}
		res.Commit()

		broadcastStickerSet(r.Context(), svc, broadcaster)
		writeJSON(w, http.StatusCreated, toStickerResponse(created))
	}
}

// readStickerUpload pulls the file out of the parsed multipart form and enforces
// the size cap, sniffed MIME type and sniffed dimensions. It writes the refusal
// itself, so a false third result means the response is complete.
func readStickerUpload(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "missing file field")
		return nil, "", false
	}
	defer file.Close() //nolint:errcheck

	// Read at most one byte past the cap so "exactly at the limit" passes and
	// "one byte over" is caught, without buffering an unbounded body.
	raw, err := io.ReadAll(io.LimitReader(file, maxStickerFileBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "failed to read uploaded file")
		return nil, "", false
	}
	if int64(len(raw)) > maxStickerFileBytes {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("sticker must be at most %d KB", maxStickerFileBytes>>10))
		return nil, "", false
	}

	mimeType := http.DetectContentType(raw)
	if !allowedStickerMIME[mimeType] {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "sticker must be a PNG, GIF or WebP image")
		return nil, "", false
	}

	width, height, err := imageDimensions(raw, mimeType)
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "could not read image dimensions")
		return nil, "", false
	}
	if width > maxStickerDimension || height > maxStickerDimension {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("sticker must be at most %dx%d pixels (got %dx%d)", maxStickerDimension, maxStickerDimension, width, height))
		return nil, "", false
	}
	return raw, mimeType, true
}

// stickerPatch is the body of PATCH /api/v1/stickers/{id}. Both fields are
// optional: an absent name or emoji is kept, and an empty emoji clears it.
type stickerPatch struct {
	Name  *string `json:"name"`
	Emoji *string `json:"emoji"`
}

func handleUpdateSticker(svc *service.Services, broadcaster StickerBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		id, idOK := stickerIDParam(w, r)
		if !idOK {
			return
		}
		if err := svc.Stickers.RequireManage(r.Context(), user.ID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		var in stickerPatch
		if !decodeJSON(w, r, &in) {
			return
		}
		current, err := svc.Stickers.Get(r.Context(), id)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		name, emoji := current.Name, ""
		if current.Emoji != nil {
			emoji = *current.Emoji
		}
		if in.Name != nil {
			name = *in.Name
		}
		if in.Emoji != nil {
			emoji = *in.Emoji
		}
		updated, err := svc.Stickers.Update(r.Context(), user.ID, id, name, emoji)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		broadcastStickerSet(r.Context(), svc, broadcaster)
		writeJSON(w, http.StatusOK, toStickerResponse(updated))
	}
}

func handleDeleteSticker(svc *service.Services, store FileStore, broadcaster StickerBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		id, idOK := stickerIDParam(w, r)
		if !idOK {
			return
		}
		removed, err := svc.Stickers.Delete(r.Context(), user.ID, id)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		removeStickerFile(store, removed)
		broadcastStickerSet(r.Context(), svc, broadcaster)
		w.WriteHeader(http.StatusNoContent)
	}
}

// removeStickerFile unlinks a deleted sticker's bytes. The row is already gone,
// so a failed unlink leaves an orphaned blob, not a broken sticker; it is logged
// rather than failing a successful delete.
func removeStickerFile(store FileStore, removed *service.Sticker) {
	if err := store.Delete(removed.StoredAs); err != nil {
		slog.Warn("failed to remove sticker file", "stored_as", removed.StoredAs, "error", err)
	}
}

// broadcastStickerSet re-reads the set and pushes it to every client. A failure
// is logged and swallowed: the mutation succeeded. The re-read is detached from
// the request context, which may be canceled by now.
func broadcastStickerSet(ctx context.Context, svc *service.Services, broadcaster StickerBroadcaster) {
	if broadcaster == nil {
		return
	}
	list, err := svc.Stickers.List(context.WithoutCancel(ctx))
	if err != nil {
		slog.Error("failed to load stickers for broadcast", "error", err)
		return
	}
	broadcaster.BroadcastStickerUpdate(list)
}

// handleServeStickerImage serves one sticker's bytes. A sticker is server-wide,
// so authentication is the whole check, and the bytes never change for an id, so
// the response caches hard.
func handleServeStickerImage(svc *service.Services, store FileStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(r, "id")
		if !ok {
			http.NotFound(w, r)
			return
		}
		s, err := svc.Stickers.Get(r.Context(), id)
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			writeServiceError(r.Context(), w, err)
			return
		}
		f, err := store.Open(s.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck

		w.Header().Set("Content-Type", s.MimeType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Cache-Control", "private, max-age=86400, immutable")

		var modTime time.Time
		if info, statErr := f.Stat(); statErr == nil {
			modTime = info.ModTime()
		}
		http.ServeContent(w, r, "sticker", modTime, f)
	}
}
