package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"

	"github.com/go-chi/chi/v5"
)

// WP 4.1c: the deadline on non-streaming REST routes (api/request_deadline.go).

func deadlineMW(d time.Duration) func(http.Handler) http.Handler {
	return api.RequestDeadlineUnless(func() time.Duration { return d }, api.RequestDeadlineExemptForTest)
}

// A handler that waits on a stalled writer fails with a 500 once its request
// context expires; the client must see a retryable 503 and none of the
// handler's body.
func TestRequestDeadline_WriterStallReturns503(t *testing.T) {
	h := deadlineMW(50 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // the held writer: nothing returns before the deadline
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Length", "17")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("database is busy"))
	}))
	rec := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil))

	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("handler ran %v; the deadline did not bound it", elapsed)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q, want 2", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "" {
		t.Fatalf("handler's Content-Length %q leaked into the rewritten response", cl)
	}
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error != "SERVICE_UNAVAILABLE" || body.Message == "" {
		t.Fatalf("body = %q (%v), want {\"error\":\"SERVICE_UNAVAILABLE\"}", rec.Body.String(), err)
	}
	if strings.Contains(rec.Body.String(), "database is busy") {
		t.Fatalf("handler body leaked: %q", rec.Body.String())
	}
}

// A success, a 4xx, or a 5xx written BEFORE the deadline is the handler's own
// answer and is delivered as written.
func TestRequestDeadline_SuccessAfterDeadlineNotRewritten(t *testing.T) {
	cases := []struct {
		name  string
		code  int
		after bool // write after the deadline expired
	}{
		{"200 after deadline", http.StatusOK, true},
		{"201 after deadline", http.StatusCreated, true},
		{"404 after deadline", http.StatusNotFound, true},
		{"500 before deadline", http.StatusInternalServerError, false},
		{"502 after deadline", http.StatusBadGateway, true},
		{"507 after deadline", http.StatusInsufficientStorage, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := deadlineMW(40 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.after {
					<-r.Context().Done()
				}
				w.Header().Set("X-Handler", "yes")
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte("handler body"))
			}))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/channels/", nil))
			if rec.Code != tc.code {
				t.Fatalf("status = %d, want %d passed through", rec.Code, tc.code)
			}
			if rec.Body.String() != "handler body" || rec.Header().Get("X-Handler") != "yes" || rec.Header().Get("Retry-After") != "" {
				t.Fatalf("response altered: body=%q header=%v", rec.Body.String(), rec.Header())
			}
		})
	}

	// An implicit 200 (Write without WriteHeader) after the deadline also passes.
	h := deadlineMW(40 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		_, _ = w.Write([]byte("ok"))
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/info", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("implicit 200 = %d %q, want 200 ok", rec.Code, rec.Body.String())
	}
}

// A 5xx after a client hang-up (context cancelled, not expired) is not the
// deadline's failure and is not rewritten.
func TestRequestDeadline_ClientCancelNotRewritten(t *testing.T) {
	h := deadlineMW(time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		w.WriteHeader(http.StatusInternalServerError)
	}))
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want the handler's 500", rec.Code)
	}
}

// The wrapper must stay transparent to http.ResponseController: flushing and
// the write-deadline controls reach the real connection.
func TestRequestDeadline_ResponseControllerReachesConnection(t *testing.T) {
	errs := make(chan error, 3)
	srv := httptest.NewServer(deadlineMW(time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rc := http.NewResponseController(w)
		errs <- rc.SetWriteDeadline(time.Time{})
		_, _ = w.Write([]byte("a"))
		errs <- rc.Flush()
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
			errs <- nil
		} else {
			errs <- http.ErrNotSupported
		}
	})))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/api/v1/info")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	for i := range 3 {
		if e := <-errs; e != nil {
			t.Fatalf("controller call %d through the wrapper: %v", i, e)
		}
	}
}

// deadlineBound lists every route the deadline covers. Keys are
// "METHOD /pattern" as chi.Walk reports them, or "* /prefix/*" for a mounted
// handler that answers every method (postureKey).
var deadlineBound = []string{
	"GET /admin/api/channels/categories",
	"POST /admin/api/channels/categories",
	"PUT /admin/api/channels/categories/order",
	"PATCH /admin/api/channels/categories/{id}",
	"DELETE /admin/api/channels/categories/{id}",
	"GET /api/v1/moderation/channels/categories",
	"POST /api/v1/moderation/channels/categories",
	"PUT /api/v1/moderation/channels/categories/order",
	"PATCH /api/v1/moderation/channels/categories/{id}",
	"DELETE /api/v1/moderation/channels/categories/{id}",
	"POST /admin/api/channels/{id}/permissions/sync",
	"GET /admin/api/channels/categories/{id}/permissions",
	"PUT /admin/api/channels/categories/{id}/permissions/{roleId}",
	"DELETE /admin/api/channels/categories/{id}/permissions/{roleId}",
	"PUT /admin/api/channels/categories/{id}/user-permissions/{userId}",
	"DELETE /admin/api/channels/categories/{id}/user-permissions/{userId}",
	"DELETE /api/v1/uploads/{id}",
	"DELETE /admin/api/backups/{name}",
	"DELETE /admin/api/channels/{id}",
	"DELETE /admin/api/channels/{id}/permissions/{roleId}",
	"DELETE /admin/api/channels/{id}/retention",
	"DELETE /admin/api/channels/{id}/user-permissions/{userId}",
	"DELETE /admin/api/logs/level",
	"DELETE /admin/api/roles/{id}",
	"DELETE /admin/api/tokens/{id}",
	"DELETE /admin/api/users/{id}/roles/{roleId}",
	"DELETE /admin/api/users/{id}/sessions",
	"DELETE /api/v1/admin/plugins/{id}",
	"DELETE /api/v1/blocks/{userId}",
	"DELETE /api/v1/channels/{id}/nsfw-acknowledgement/",
	"DELETE /api/v1/channels/{id}/pins/{messageId}",
	"DELETE /api/v1/dms/{channelId}",
	"DELETE /api/v1/dms/{channelId}/icon",
	"DELETE /api/v1/dms/{channelId}/members/{userId}",
	"DELETE /api/v1/emoji/{id}",
	"DELETE /api/v1/gif/favorites",
	"DELETE /api/v1/invites/{code}",
	"DELETE /api/v1/moderation/channels/{id}",
	"DELETE /api/v1/moderation/members/{id}/roles/{roleId}",
	"DELETE /api/v1/moderation/members/{id}/sessions",
	"DELETE /api/v1/push/subscriptions/{id}",
	"DELETE /api/v1/stickers/{id}",
	"DELETE /api/v1/users/me/avatar",
	"DELETE /api/v1/users/me/banner",
	"DELETE /api/v1/users/me/sessions",
	"DELETE /api/v1/users/me/sessions/{id}",
	"DELETE /api/v1/users/me/totp",
	"DELETE /api/v1/users/me/uploads/{id}",
	"GET /admin/",
	"* /admin/*",
	"GET /admin/api/attention",
	"GET /admin/api/audit-log",
	"GET /admin/api/backups",
	"GET /admin/api/channels",
	"GET /admin/api/channels/{id}/access/explain",
	"GET /admin/api/channels/{id}/permissions",
	"GET /admin/api/config",
	"GET /admin/api/discord-imports/latest",
	"GET /admin/api/discord-imports/{id}",
	"GET /admin/api/config/settings",
	"GET /admin/api/logs/level",
	"GET /admin/api/me",
	"GET /admin/api/registrations",
	"GET /admin/api/retention",
	"GET /admin/api/retention/channels",
	"GET /admin/api/retention/preview",
	"GET /admin/api/roles",
	"GET /admin/api/settings",
	"GET /admin/api/setup/status",
	"GET /admin/api/stats",
	"GET /admin/api/storage/files",
	"GET /admin/api/storage/leftovers",
	"GET /admin/api/storage/members",
	"GET /admin/api/storage/summary",
	"GET /admin/api/tokens",
	"GET /admin/api/updates",
	"GET /admin/api/users",
	"GET /api/v1/admin/plugins/",
	"GET /api/v1/appeals/mine",
	"GET /api/v1/auth/me",
	"GET /api/v1/blocks/",
	"GET /api/v1/channels/",
	"GET /api/v1/channels/{id}/media",
	"GET /api/v1/channels/{id}/media/months",
	"GET /api/v1/channels/{id}/messages",
	"GET /api/v1/channels/{id}/messages/around/{messageId}",
	"GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users",
	"GET /api/v1/channels/{id}/pins",
	"GET /api/v1/channels/{id}/threads",
	"GET /api/v1/diagnostics/connectivity",
	"GET /api/v1/dm-requests/",
	"GET /api/v1/dms/",
	"GET /api/v1/emoji/",
	"GET /api/v1/emoji/{id}/image",
	"GET /api/v1/gif/favorites",
	"GET /api/v1/gif/search",
	"GET /api/v1/gif/trending",
	"GET /api/v1/health",
	"GET /api/v1/info",
	"GET /api/v1/invites/",
	"GET /api/v1/invites/{code}/redemptions",
	"GET /api/v1/livekit/health",
	"GET /api/v1/metrics",
	"GET /api/v1/metrics/prometheus",
	"GET /api/v1/moderation/appeals/",
	"GET /api/v1/moderation/appeals/{id}",
	"GET /api/v1/moderation/members/",
	"GET /api/v1/moderation/queue/",
	"GET /api/v1/moderation/queue/{id}",
	"GET /api/v1/moderation/users/{id}/actions",
	"GET /api/v1/push/subscriptions",
	"GET /api/v1/push/vapid",
	"GET /api/v1/reports/mine",
	"GET /api/v1/search",
	"GET /api/v1/server-info",
	"GET /api/v1/stickers/",
	"GET /api/v1/stickers/{id}/image",
	"GET /api/v1/users/me/moderation",
	"GET /api/v1/users/me/notes/{userId}",
	"GET /api/v1/users/me/privacy",
	"GET /api/v1/users/me/recovery-kit",
	"GET /api/v1/users/me/sessions",
	"GET /api/v1/users/me/storage",
	"GET /api/v1/users/me/uploads",
	"GET /health",
	"PATCH /admin/api/channels/{id}",
	"PATCH /admin/api/config/settings",
	"PATCH /admin/api/logs/level",
	"PATCH /admin/api/roles/reorder",
	"PATCH /admin/api/roles/{id}",
	"PATCH /admin/api/settings",
	"PATCH /admin/api/users/{id}",
	"PATCH /admin/api/users/{id}/upload-limit",
	"PATCH /api/v1/dms/{channelId}",
	"PATCH /api/v1/moderation/channels/{id}",
	"PATCH /api/v1/moderation/members/{id}",
	"PATCH /api/v1/stickers/{id}",
	"PATCH /api/v1/users/me/",
	"POST /admin/api/archive/link",
	"POST /admin/api/backups/{name}/link",
	"POST /admin/api/channels",
	"POST /admin/api/channels/{id}/access/preview",
	"POST /admin/api/discord-imports/{id}/cancel",
	"POST /admin/api/logs/ticket",
	"POST /admin/api/registrations/{id}/approve",
	"POST /admin/api/registrations/{id}/deny",
	"POST /admin/api/retention/preview",
	"POST /admin/api/roles",
	"POST /admin/api/setup",
	"POST /admin/api/storage/files/delete",
	"POST /admin/api/storage/leftovers",
	"POST /admin/api/support-bundles/download",
	"POST /admin/api/support-bundles/preview",
	"POST /admin/api/tokens",
	"POST /admin/api/users/{id}/recovery-credential",
	"POST /api/v1/appeals/",
	"POST /api/v1/appeals/{id}/withdraw",
	"POST /api/v1/auth/login",
	"POST /api/v1/auth/logout",
	"POST /api/v1/auth/recover",
	"POST /api/v1/auth/register",
	"POST /api/v1/auth/verify-totp",
	"POST /api/v1/channels/{id}/messages/purge",
	"POST /api/v1/channels/{id}/pins/{messageId}",
	"POST /api/v1/dm-requests/{id}/accept",
	"POST /api/v1/dm-requests/{id}/block",
	"POST /api/v1/dm-requests/{id}/delete",
	"POST /api/v1/dm-requests/{id}/ignore",
	"POST /api/v1/dms/",
	"POST /api/v1/dms/group",
	"POST /api/v1/dms/{channelId}/members",
	"POST /api/v1/files/{id}/link",
	"POST /api/v1/invites/",
	"POST /api/v1/livekit/webhook",
	"POST /api/v1/moderation/appeals/{id}/assign",
	"POST /api/v1/moderation/appeals/{id}/decide",
	"POST /api/v1/moderation/channels/",
	"POST /api/v1/moderation/queue/{id}/act",
	"POST /api/v1/moderation/queue/{id}/assign",
	"POST /api/v1/moderation/queue/{id}/close",
	"POST /api/v1/moderation/queue/{id}/notes",
	"POST /api/v1/moderation/users/{id}/timeout",
	"POST /api/v1/moderation/users/{id}/untimeout",
	"POST /api/v1/moderation/users/{id}/warn",
	"POST /api/v1/push/subscriptions",
	"POST /api/v1/reports/",
	"POST /api/v1/users/me/notices/{id}/ack",
	"POST /api/v1/users/me/recovery-kit",
	"POST /api/v1/users/me/totp/confirm",
	"POST /api/v1/users/me/totp/enable",
	"POST /api/v1/users/me/totp/recovery-codes",
	"PUT /admin/api/afk-channel",
	"PUT /admin/api/channels/{id}/forum",
	"PUT /admin/api/channels/{id}/permissions/{roleId}",
	"PUT /admin/api/channels/{id}/retention",
	"PUT /admin/api/channels/{id}/user-permissions/{userId}",
	"PUT /admin/api/users/{id}/roles/{roleId}",
	"PUT /api/v1/blocks/{userId}",
	"PUT /api/v1/channels/{id}/nsfw-acknowledgement/",
	"PUT /api/v1/dms/{channelId}/owner",
	"PUT /api/v1/gif/favorites",
	"PUT /api/v1/moderation/channels/{id}/forum",
	"PUT /api/v1/moderation/members/{id}/roles/{roleId}",
	"PUT /api/v1/moderation/users/{id}/nickname",
	"PUT /api/v1/users/me/notes/{userId}",
	"PUT /api/v1/users/me/password",
	"PUT /api/v1/users/me/privacy",
}

// deadlineExempt lists every walked route the exempt table must skip, with the
// reason it is exempt. It mirrors requestDeadlineExempt in
// api/request_deadline.go; the test checks both directions.
var deadlineExempt = map[string]string{
	"GET /api/v1/ws":                                       "WebSocket upgrade; r.Context() is the socket's lifetime",
	"* /livekit/*":                                         "LiveKit signalling proxy",
	"POST /api/v1/uploads":                                 "file upload under the transfer deadline",
	"POST /api/v1/emoji/":                                  "custom emoji upload",
	"POST /api/v1/stickers/":                               "custom sticker upload",
	"POST /api/v1/admin/plugins/{id}/enable":               "plugin enable recompiles under the request context",
	"POST /api/v1/admin/plugins/{id}/disable":              "plugin disable, for symmetry with enable",
	"POST /api/v1/users/me/avatar":                         "avatar upload",
	"POST /api/v1/users/me/banner":                         "banner upload",
	"POST /api/v1/dms/{channelId}/icon":                    "group icon upload",
	"GET /api/v1/files/{id}":                               "file download",
	"GET /api/v1/files/{id}/thumb":                         "thumbnail download",
	"GET /api/v1/client-update/{target}/{current_version}": "desktop update relay",
	"GET /admin/api/archive":                               "full-archive stream",
	"GET /admin/api/archive/download":                      "link-token archive stream",
	"POST /admin/api/backup":                               "database backup",
	"GET /admin/api/backups/{name}/download":               "backup file stream",
	"POST /admin/api/backups/{name}/restore":               "restore",
	"POST /admin/api/discord-imports/upload":               "Discord export upload",
	"POST /admin/api/updates/apply":                        "update download and apply",
	"POST /admin/api/restart":                              "process restart hand-off",
	"POST /api/v1/admin/plugins/install":                   "plugin upload and compile",
	"DELETE /api/v1/auth/account":                          "account erasure",
	"DELETE /admin/api/users/{id}":                         "admin account erasure",
}

// deadlineOptionalBound are bound routes that mount only under a build tag
// (the otel Prometheus exporter) or a config key (the browser client portal,
// 6.13a), accepted when present.
var deadlineOptionalBound = map[string]bool{
	"* /metrics/*": true,
	"GET /":        true,
	"* /assets/*":  true,
	// The browser client's external-content broker mounts with the portal.
	"GET /api/v1/external/preview": true,
	"GET /api/v1/external/image":   true,
}

// deadlineOptionalExempt are exempt routes that mount only under a build tag
// or configuration (the walk accepts them when present).
var deadlineOptionalExempt = map[string]string{
	"GET /admin/api/logs/stream": "SSE log stream; mounts only when a log buffer is wired",
}

// TestRequestDeadline_EveryRouteClassified walks the built router: every
// route is bound or exempt through the explicit lists above, the exempt table
// agrees with the exempt list for each route, and nothing listed or in the
// table is stale. A new route fails here until it is classified.
func TestRequestDeadline_EveryRouteClassified(t *testing.T) {
	routes, ok := fullRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router is not a chi.Routes")
	}
	bound := map[string]bool{}
	for _, k := range deadlineBound {
		if bound[k] {
			t.Errorf("deadlineBound lists %q twice", k)
		}
		bound[k] = true
	}
	seen := map[string]bool{}
	var tableHits = map[string]bool{} // exempt-table patterns that matched a real route
	exemptions := api.RequestDeadlineExemptionsForTest()
	for _, e := range exemptions {
		if strings.TrimSpace(e.Reason) == "" {
			t.Errorf("exempt entry %q has no reason", e.Pattern)
		}
	}

	walk := func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := postureKey(method, pattern)
		if seen[key] {
			return nil
		}
		seen[key] = true
		_, isExempt := deadlineExempt[key]
		_, isOptional := deadlineOptionalExempt[key]
		isExempt = isExempt || isOptional
		isOptionalPublic := deadlineOptionalBound[key]
		switch {
		case isExempt && bound[key]:
			t.Errorf("%s is listed both bound and exempt", key)
		case !isExempt && !bound[key] && !isOptionalPublic:
			t.Errorf("%s is neither bound nor exempt: add it to deadlineBound, or to deadlineExempt and requestDeadlineExempt with a reason", key)
		}
		m := method
		if strings.HasPrefix(key, "* ") {
			m = http.MethodGet
		}
		path := concretePath(pattern)
		got := api.RequestDeadlineExemptForTest(m, path)
		if got != isExempt && !isOptionalPublic {
			t.Errorf("%s: exempt table says %v, deadlineExempt says %v", key, got, isExempt)
		}
		for _, e := range exemptions {
			if (e.Method == "" || e.Method == m) && regexp.MustCompile(e.Pattern).MatchString(path) {
				tableHits[e.Pattern] = true
			}
		}
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}

	if len(seen) < 100 {
		t.Fatalf("walked only %d routes; expected the full production router", len(seen))
	}
	var stale []string
	for k := range deadlineExempt {
		if !seen[k] {
			stale = append(stale, "deadlineExempt: "+k)
		}
	}
	for _, k := range deadlineBound {
		if !seen[k] {
			stale = append(stale, "deadlineBound: "+k)
		}
	}
	for _, e := range exemptions {
		if !tableHits[e.Pattern] && !optionalExemptPattern(e.Pattern) {
			stale = append(stale, "requestDeadlineExempt: "+e.Pattern)
		}
	}
	slices.Sort(stale)
	if len(stale) > 0 {
		t.Fatalf("entries that match no mounted route — remove them:\n  %s", strings.Join(stale, "\n  "))
	}
}

// optionalExemptPattern reports whether an exempt-table pattern names a route
// that mounts only conditionally (deadlineOptionalExempt).
func optionalExemptPattern(pattern string) bool {
	for key := range deadlineOptionalExempt {
		path := key[strings.Index(key, " ")+1:]
		if regexp.MustCompile(pattern).MatchString(path) {
			return true
		}
	}
	return false
}

// The exempt routes must carry no deadline (a WebSocket killed at 15 s, an
// upload cut mid-body); a bound route must carry one.
func TestRequestDeadline_ExemptRoutesHaveNoDeadline(t *testing.T) {
	var gotDeadline bool
	h := deadlineMW(time.Minute)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, gotDeadline = r.Context().Deadline()
	}))
	cases := []struct {
		method, path string
		want         bool // deadline expected
	}{
		{http.MethodGet, "/api/v1/ws", false},
		{http.MethodPost, "/api/v1/uploads", false},
		{http.MethodPost, "/api/v1/users/me/avatar", false},
		{http.MethodPost, "/api/v1/dms/12/icon", false},
		{http.MethodGet, "/api/v1/files/7", false},
		{http.MethodGet, "/api/v1/files/7/thumb", false},
		{http.MethodGet, "/livekit/rtc", false},
		{http.MethodGet, "/admin/api/logs/stream", false},
		{http.MethodDelete, "/api/v1/auth/account", false},
		{http.MethodPost, "/api/v1/emoji/", false},
		{http.MethodPost, "/api/v1/stickers/", false},
		{http.MethodPost, "/api/v1/admin/plugins/p1/enable", false},
		{http.MethodPost, "/api/v1/admin/plugins/p1/disable", false},
		{http.MethodDelete, "/api/v1/uploads/9", true},
		{http.MethodGet, "/api/v1/channels/", true},
		{http.MethodPost, "/api/v1/auth/login", true},
		{http.MethodGet, "/api/v1/server-info", true},
		{http.MethodGet, "/api/v1/health", true},
		{http.MethodGet, "/admin/api/users", true},
		{http.MethodDelete, "/admin/api/channels/3", true},
		{http.MethodGet, "/", true},
		{http.MethodGet, "/assets/index-abc.js", true},
	}
	for _, tc := range cases {
		gotDeadline = false
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, bytes.NewReader(nil)))
		if gotDeadline != tc.want {
			t.Errorf("%s %s: deadline present = %v, want %v", tc.method, tc.path, gotDeadline, tc.want)
		}
	}
}
