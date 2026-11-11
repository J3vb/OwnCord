package api

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register the GIF decoder for image.DecodeConfig
	_ "image/jpeg" // register the JPEG decoder for image.DecodeConfig
	_ "image/png"  // register the PNG decoder for image.DecodeConfig
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// EmojiBroadcaster is the slice of the hub the emoji routes need: after every mutation the full set is
// pushed to all clients.
type EmojiBroadcaster interface {
	BroadcastEmojiUpdate(list []*db.Emoji)
}

// Deliberately not db.Emoji: the storage id and sniffed mime type are server-side details.
type emojiResponse struct {
	ID        int64  `json:"id"`
	Shortcode string `json:"shortcode"`
	URL       string `json:"url"`
}

func toEmojiResponse(e *db.Emoji) emojiResponse {
	return emojiResponse{ID: e.ID, Shortcode: e.Shortcode, URL: service.EmojiImageURL(e.ID)}
}

func toEmojiResponses(list []*db.Emoji) []emojiResponse {
	out := make([]emojiResponse, 0, len(list))
	for _, e := range list {
		if e == nil {
			continue
		}
		out = append(out, toEmojiResponse(e))
	}
	return out
}

// Image types an emoji may be, matched against the sniffed type. SVG is absent on purpose: it is
// script-capable markup that isUnsafeInlineMIME forces to a download, and an emoji always renders inline.
var allowedEmojiMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// MountEmojiRoutes registers the custom-emoji endpoints; all need authentication. POST and DELETE are
// gated on MANAGE_SERVER inside EmojiService. The image route is authenticated so an emoji cannot serve as
// a tracking pixel hosted on someone else's server.
func MountEmojiRoutes(r chi.Router, svc *service.Services, store FileStore, limiter *auth.RateLimiter, broadcaster EmojiBroadcaster) {
	r.Route("/api/v1/emoji", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListEmoji(svc))
		r.Get("/{id}/image", handleServeEmojiImage(svc, store))
		r.With(MaxBodySize(emojiMaxBodySize)).
			Post("/", handleCreateEmoji(svc, store, limiter, broadcaster))
		r.Delete("/{id}", handleDeleteEmoji(svc, store, broadcaster))
	})
}

func handleListEmoji(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.Emoji.List(r.Context())
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, toEmojiResponses(list))
	}
}

// handleCreateEmoji processes POST /api/v1/emoji (multipart: `file` + `shortcode`). The permission gate
// runs BEFORE the multipart parse so a member without MANAGE_SERVER cannot make the server spool a body to
// disk.
func handleCreateEmoji(svc *service.Services, store FileStore, limiter *auth.RateLimiter, broadcaster EmojiBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		if err := svc.Emoji.RequireManage(r.Context(), user.ID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		if limiter != nil && !limiter.Allow(auth.Key("emoji_upload", user.ID), emojiUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "emoji upload rate limit exceeded, try again later")
			return
		}

		// Bound the body before the multipart parser, which is what turns an unbounded body into heap.
		r.Body = http.MaxBytesReader(w, r.Body, emojiMaxBodySize)

		if err := r.ParseMultipartForm(emojiMultipartMemoryLimit); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}

		shortcode, err := service.ValidateShortcode(r.FormValue("shortcode"))
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		raw, mimeType, readOK := readEmojiUpload(w, r)
		if !readOK {
			return
		}

		// Emoji are a bounded exclusion from the per-user quota (server-wide, MANAGE_SERVER-gated, capped at
		// service.MaxEmojiCount files) but not from the headroom floor: a full disk is full for everyone.
		res, err := svc.Uploads.ReserveHeadroom(r.Context(), int64(len(raw)))
		if err != nil {
			writeStorageSaveError(w, err, "emoji upload")
			return
		}
		defer res.Settle(r.Context())

		storedAs := uuid.New().String()
		if _, saveErr := saveReserved(r.Context(), res, store, storedAs, bytes.NewReader(raw)); saveErr != nil {
			// writeStorageSaveError also keeps raw storage errors (absolute paths) out of the response body.
			writeStorageSaveError(w, saveErr, "emoji upload")
			return
		}

		created, err := svc.Emoji.Create(r.Context(), user.ID, shortcode, storedAs, mimeType)
		if err != nil {
			// The row never landed, so the file is an orphan; unlink it.
			if delErr := store.Delete(storedAs); delErr != nil {
				slog.Error("failed to clean up orphaned emoji file", "stored_as", storedAs, "error", delErr)
			}
			writeServiceError(r.Context(), w, err)
			return
		}
		res.Commit()

		broadcastEmojiSet(r.Context(), svc, broadcaster)
		writeJSON(w, http.StatusCreated, toEmojiResponse(created))
	}
}

// readEmojiUpload pulls the file from the parsed form and enforces size, sniffed MIME and dimensions. It
// writes the refusal itself, so a false third result means the response is complete.
func readEmojiUpload(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "missing file field")
		return nil, "", false
	}
	defer file.Close() //nolint:errcheck

	// Read one byte past the cap so exactly-at-limit passes and one-over is caught without buffering an
	// unbounded body.
	raw, err := io.ReadAll(io.LimitReader(file, maxEmojiFileBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "failed to read uploaded file")
		return nil, "", false
	}
	if int64(len(raw)) > maxEmojiFileBytes {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("emoji must be at most %d KB", maxEmojiFileBytes>>10))
		return nil, "", false
	}

	mimeType := http.DetectContentType(raw)
	if !allowedEmojiMIME[mimeType] {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "emoji must be a PNG, JPEG, GIF or WebP image")
		return nil, "", false
	}

	width, height, err := imageDimensions(raw, mimeType)
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "could not read image dimensions")
		return nil, "", false
	}
	// Re-check the sniffed dimensions rather than trust the client, so an "emoji" is not a full-size picture.
	if width <= 0 || height <= 0 || width > maxEmojiDimension || height > maxEmojiDimension {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("emoji must be at most %dx%d pixels (got %dx%d)", maxEmojiDimension, maxEmojiDimension, width, height))
		return nil, "", false
	}

	return raw, mimeType, true
}

func handleDeleteEmoji(svc *service.Services, store FileStore, broadcaster EmojiBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		id, ok := pathID(r, "id")
		if !ok {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid emoji id")
			return
		}

		removed, err := svc.Emoji.Delete(r.Context(), user.ID, id)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// The row is already gone, so a failed unlink leaves an orphaned blob, not a broken emoji; log it.
		if delErr := store.Delete(removed.StoredAs); delErr != nil {
			slog.Warn("failed to remove emoji file", "stored_as", removed.StoredAs, "error", delErr)
		}

		broadcastEmojiSet(r.Context(), svc, broadcaster)
		w.WriteHeader(http.StatusNoContent)
	}
}

// broadcastEmojiSet re-reads the set and pushes it to every client. A failure is logged and swallowed: the
// mutation succeeded. It runs after commit, so the re-read is detached with context.WithoutCancel.
func broadcastEmojiSet(ctx context.Context, svc *service.Services, broadcaster EmojiBroadcaster) {
	if broadcaster == nil {
		return
	}
	list, err := svc.Emoji.List(context.WithoutCancel(ctx))
	if err != nil {
		slog.Error("failed to load emoji for broadcast", "error", err)
		return
	}
	broadcaster.BroadcastEmojiUpdate(list)
}

// handleServeEmojiImage serves one emoji's bytes. An emoji is server-wide, so authentication is the whole
// check; the response is immutable for the id's lifetime (a replacement is a new row), so it caches hard.
func handleServeEmojiImage(svc *service.Services, store FileStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(r, "id")
		if !ok {
			http.NotFound(w, r)
			return
		}
		e, err := svc.Emoji.Get(r.Context(), id)
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			writeServiceError(r.Context(), w, err)
			return
		}
		f, err := store.Open(e.StoredAs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck

		w.Header().Set("Content-Type", e.MimeType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Disposition", "inline")
		// Private (it needed a session) but immutable, so a client may keep it for a day.
		w.Header().Set("Cache-Control", "private, max-age=86400, immutable")

		var modTime time.Time
		if info, statErr := f.Stat(); statErr == nil {
			modTime = info.ModTime()
		}
		http.ServeContent(w, r, e.Shortcode, modTime, f)
	}
}

// imageDimensions returns the pixel size of an image of an allowed type. WebP has no stdlib decoder, so its
// header is read directly (decoding a frame just for its size is the work the cap exists to avoid). Shared
// by the emoji and avatar upload routes.
func imageDimensions(raw []byte, mimeType string) (width, height int, err error) {
	if mimeType == "image/webp" {
		width, height, err = webpDimensions(raw)
	} else {
		var cfg image.Config
		cfg, _, err = image.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			return 0, 0, fmt.Errorf("decoding image config: %w", err)
		}
		width, height = cfg.Width, cfg.Height
	}
	if err != nil {
		return 0, 0, err
	}
	// Callers compare a non-error result straight against their pixel cap, so reject zero width or height
	// here: Go's GIF DecodeConfig reports height=0 for a malformed screen descriptor.
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("decoding image config: non-positive dimensions %dx%d", width, height)
	}
	return width, height, nil
}

// errBadWebP is returned for any WebP whose header does not parse; the caller answers 400.
var errBadWebP = errors.New("malformed WebP header")

// webpDimensions reads the canvas size out of a RIFF/WEBP container: VP8 (lossy), VP8L (lossless) and VP8X
// (extended, used by animated or alpha WebP).
func webpDimensions(raw []byte) (width, height int, err error) {
	if len(raw) < 16 || string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WEBP" {
		return 0, 0, errBadWebP
	}
	switch string(raw[12:16]) {
	case "VP8 ":
		if len(raw) < 30 {
			return 0, 0, errBadWebP
		}
		if raw[23] != 0x9d || raw[24] != 0x01 || raw[25] != 0x2a {
			return 0, 0, errBadWebP
		}
		w := int(binary.LittleEndian.Uint16(raw[26:28]) & 0x3FFF)
		h := int(binary.LittleEndian.Uint16(raw[28:30]) & 0x3FFF)
		// VP8 stores size directly (unlike VP8L/VP8X, which store size-1): an all-zero field is a degenerate
		// header; reject it.
		if w == 0 || h == 0 {
			return 0, 0, errBadWebP
		}
		return w, h, nil
	case "VP8L":
		if len(raw) < 25 || raw[20] != 0x2F {
			return 0, 0, errBadWebP
		}
		bits := binary.LittleEndian.Uint32(raw[21:25])
		w := int(bits&0x3FFF) + 1
		h := int((bits>>14)&0x3FFF) + 1
		return w, h, nil
	case "VP8X":
		if len(raw) < 30 {
			return 0, 0, errBadWebP
		}
		w := int(uint32(raw[24]) | uint32(raw[25])<<8 | uint32(raw[26])<<16)
		h := int(uint32(raw[27]) | uint32(raw[28])<<8 | uint32(raw[29])<<16)
		return w + 1, h + 1, nil
	default:
		return 0, 0, errBadWebP
	}
}
