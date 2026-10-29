package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// A deadline on the non-streaming REST routes.
//
// A request that waits on a stalled database writer holds its goroutine, its
// connection and (once the 30 s WriteTimeout passes) loses its response. The
// middleware gives every non-exempt request a context deadline of
// restRequestDeadline, short enough to leave room to write an answer inside
// the server's 30 s WriteTimeout. Handlers that pass r.Context() to the
// database see the deadline as a cancelled query. When such a handler then
// fails with a 5xx AFTER the deadline, the failure is the deadline's, and
// the writer wrapper turns a 500 or 503 into 503 SERVICE_UNAVAILABLE with Retry-After
// (the client already maps both: Client/src/lib/api.ts). A status below 500 is
// never rewritten, so a request that committed and answered 2xx stays a
// success, and a 4xx stays the handler's own verdict.
//
// The deadline is a context deadline, not a handler kill: the handler goroutine
// runs to completion, and a route that ignores its context is not interrupted.
// It can only fail a request before its commit, because post-commit steps are
// detached from the request context.

// requestDeadlineRewritable reports the statuses the deadline turns into 503:
// the generic 500 and 503 a handler answers when its work is cancelled. A
// specific 5xx code (502 UPDATE_CHECK_FAILED, 507 STORAGE_ERROR) is kept.
func requestDeadlineRewritable(code int) bool {
	return code == http.StatusInternalServerError || code == http.StatusServiceUnavailable
}

// restRequestDeadline bounds one non-exempt REST request. A package var, not a
// config key, so tests can shrink it; the 30 s WriteTimeout in
// internal/app/lifecycle.go leaves room to answer after it fires.
var restRequestDeadline = 15 * time.Second

// requestDeadlineRetryAfter is the Retry-After value (seconds) of the 503.
const requestDeadlineRetryAfter = "2"

// requestDeadlineBody is the fixed 503 body.
const requestDeadlineBody = `{"error":"` + string(httperr.CodeServiceUnavailable) + `","message":"the server is busy; try again"}` + "\n"

// requestDeadlineExemption is one route (or family) the deadline must not
// touch. method is "" for any method. path is matched against the request's
// escaped path, like bodyCapExemptPattern.
type requestDeadlineExemption struct {
	method string
	path   *regexp.Regexp
	reason string
}

// requestDeadlineExempt is the exempt table: every route that streams, holds a
// connection open or is deliberately long-running. Each entry carries its
// reason. TestRequestDeadline_EveryRouteClassified fails on a mounted route
// that is neither exempt here nor listed as bound, and on an entry here that
// matches no mounted route — add a route there, with a reason, rather than
// widening a pattern.
var requestDeadlineExempt = []requestDeadlineExemption{
	{http.MethodGet, regexp.MustCompile(`^/api/v1/ws$`),
		"the WebSocket upgrade: r.Context() is the socket's lifetime, so a deadline would close every connection at 15 s"},
	{"", regexp.MustCompile(`^/livekit/`),
		"the LiveKit proxy, signalling sockets included (and the Linux native voice Bearer path)"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/uploads$`),
		"file upload: the transfer deadline (transfer_deadline.go) governs it, and a slow uplink legitimately exceeds 15 s"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/users/me/avatar$`),
		"avatar upload: the transfer deadline governs it"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/users/me/banner$`),
		"banner upload: the same body cap and handling as the avatar upload"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/emoji/$`),
		"custom emoji upload: a body upload at the 1 MiB cap, grouped with the avatar upload"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/stickers/$`),
		"custom sticker upload: a body upload at the 1 MiB cap, grouped with the emoji upload"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/dms/[0-9]+/icon$`),
		"group icon upload: the transfer deadline governs it"},
	{http.MethodGet, regexp.MustCompile(`^/api/v1/files/[^/]+(/thumb)?$`),
		"file download and thumbnail: streamed under the transfer deadline"},
	{"", regexp.MustCompile(`^/api/v1/client-update/`),
		"desktop update manifest and installer relay: streamed from a remote source"},
	{http.MethodGet, regexp.MustCompile(`^/admin/api/logs/stream$`),
		"server-sent events: open until the viewer leaves (mounts only when a log buffer is wired)"},
	{http.MethodGet, regexp.MustCompile(`^/admin/api/archive$`),
		"full-archive build and download, under the archive progress deadline"},
	{http.MethodGet, regexp.MustCompile(`^/admin/api/archive/download$`),
		"link-token archive download, under the archive progress deadline"},
	{http.MethodPost, regexp.MustCompile(`^/admin/api/backup$`),
		"database backup: runs as long as the database is large"},
	{http.MethodGet, regexp.MustCompile(`^/admin/api/backups/[^/]+/download$`),
		"backup file download: streamed"},
	{http.MethodPost, regexp.MustCompile(`^/admin/api/backups/[^/]+/restore$`),
		"restore: drains connections and replaces the database; a half-cancelled restore would corrupt"},
	{http.MethodPost, regexp.MustCompile(`^/admin/api/updates/apply$`),
		"update apply: downloads and verifies a release binary (5 min budget of its own)"},
	{http.MethodPost, regexp.MustCompile(`^/admin/api/restart$`),
		"restart hand-off: tears the process down"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/admin/plugins/install$`),
		"plugin install: uploads and compiles a WASM module (16 MiB envelope)"},
	{http.MethodPost, regexp.MustCompile(`^/api/v1/admin/plugins/[^/]+/(enable|disable)$`),
		"plugin enable recompiles the WASM module under the request context, and a 503 on a slow compile would never succeed on retry; disable is exempt for symmetry"},
	{http.MethodDelete, regexp.MustCompile(`^/api/v1/auth/account$`),
		"account erasure: its own bounded, resumable work; a deadline must not abandon it midway"},
	{http.MethodDelete, regexp.MustCompile(`^/admin/api/users/[^/]+$`),
		"admin-initiated account erasure: same as DELETE /api/v1/auth/account"},
}

// requestDeadlineExemptRequest reports whether the deadline skips a request.
func requestDeadlineExemptRequest(method, escapedPath string) bool {
	for _, e := range requestDeadlineExempt {
		if (e.method == "" || e.method == method) && e.path.MatchString(escapedPath) {
			return true
		}
	}
	return false
}

// RequestDeadlineUnless gives every request whose method and path are not in
// the exempt table a context deadline of d, and rewrites a 500 or 503 the handler
// writes after that deadline into 503 SERVICE_UNAVAILABLE with Retry-After. d
// is read per request so tests can shrink the package var.
func RequestDeadlineUnless(d func() time.Duration, exempt func(method, escapedPath string) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if exempt(r.Method, r.URL.EscapedPath()) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), d())
			defer cancel()
			dw := &deadlineWriter{ResponseWriter: w, ctx: ctx, method: r.Method, path: r.URL.Path}
			next.ServeHTTP(dw, r.WithContext(ctx))
		})
	}
}

// requestDeadlineMiddleware is the production wiring: the restRequestDeadline
// var and the exempt table.
func requestDeadlineMiddleware() func(http.Handler) http.Handler {
	return RequestDeadlineUnless(func() time.Duration { return restRequestDeadline }, requestDeadlineExemptRequest)
}

// deadlineWriter rewrites a post-deadline 5xx. It is not safe for concurrent
// use, like any ResponseWriter. Unwrap keeps http.ResponseController (and so
// Flusher, Hijacker and the write-deadline controls) reaching the connection.
type deadlineWriter struct {
	http.ResponseWriter
	ctx    context.Context
	method string
	path   string

	wroteHeader bool
	rewritten   bool
}

// Unwrap returns the underlying writer for http.ResponseController.
func (w *deadlineWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// WriteHeader passes a status through unless it is a 5xx written after the
// request's own deadline expired; that one becomes the 503 and the handler's
// body is dropped (only 500 and 503). 1xx informational statuses pass without committing.
func (w *deadlineWriter) WriteHeader(code int) {
	if code >= 100 && code < 200 && code != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	if requestDeadlineRewritable(code) && errors.Is(w.ctx.Err(), context.DeadlineExceeded) {
		w.rewritten = true
		slog.WarnContext(w.ctx, "request deadline exceeded; answering 503 instead of the handler's failure",
			"method", w.method, "path", truncateForLog(w.path, maxLoggedPathLen), "handler_status", code)
		h := w.Header()
		// Drop only what described the handler's own body; the security
		// headers and request id set by outer middleware stay.
		for _, k := range []string{"Content-Length", "Content-Encoding", "Content-Disposition", "ETag", "Last-Modified", "Location", "Set-Cookie"} {
			h.Del(k)
		}
		h.Set("Content-Type", "application/json")
		h.Set("Retry-After", requestDeadlineRetryAfter)
		h.Set("Cache-Control", "no-store")
		w.ResponseWriter.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.ResponseWriter.Write([]byte(requestDeadlineBody))
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

// Write commits an implicit 200 like net/http does, and drops the handler's
// body once the status was rewritten.
func (w *deadlineWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.rewritten {
		return len(p), nil
	}
	return w.ResponseWriter.Write(p)
}

// Flush commits an implicit 200 and flushes, unless the response was rewritten
// (already complete).
func (w *deadlineWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.rewritten {
		return
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

// truncateForLog bounds a client-controlled string before it becomes a log
// attribute, so it cannot inflate the retained ring-buffer entries.
func truncateForLog(s string, max int) string { //nolint:unparam // callers share one bound today; kept generic
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}
