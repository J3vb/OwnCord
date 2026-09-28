package admin

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// archiveLinkTTL is how long a single-use archive link stays valid. It is
// short by design: the owner asks for it and the browser opens it immediately,
// so a minute is generous and a leaked link is near-useless.
const archiveLinkTTL = 60 * time.Second

// archiveLinkTTLOverride, when non-zero, replaces archiveLinkTTL. Test-only.
var archiveLinkTTLOverride atomic.Int64

// SetArchiveLinkTTLForTest overrides the link lifetime; 0 restores the
// production default. Exported for the external test package only.
func SetArchiveLinkTTLForTest(d time.Duration) { archiveLinkTTLOverride.Store(int64(d)) }

func archiveLinkLifetime() time.Duration {
	if d := archiveLinkTTLOverride.Load(); d > 0 {
		return time.Duration(d)
	}
	return archiveLinkTTL
}

// archiveLink is one issued, not-yet-used link token.
type archiveLink struct {
	actorID int64
	expires time.Time
}

// archiveLinks holds the outstanding single-use tokens. It is process-local:
// a restart voids every outstanding link, which is the safe direction.
type archiveLinks struct {
	mu     syncutil.Mutex
	tokens map[string]archiveLink
}

var linkStore = &archiveLinks{tokens: make(map[string]archiveLink)}

// issue mints a random single-use token bound to actorID and expiring after
// archiveLinkLifetime. The token is never logged.
func (s *archiveLinks) issue(actorID int64) (string, time.Time, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(b)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	// Opportunistic sweep of expired tokens so the map cannot grow unbounded.
	for k, v := range s.tokens {
		if now.After(v.expires) {
			delete(s.tokens, k)
		}
	}
	expires := now.Add(archiveLinkLifetime())
	s.tokens[token] = archiveLink{actorID: actorID, expires: expires}
	return token, expires, nil
}

// redeem consumes a token, returning the bound actor and whether it was valid
// and unexpired. A token is deleted on first use, so it can never work twice.
func (s *archiveLinks) redeem(token string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.tokens[token]
	if !ok {
		return 0, false
	}
	delete(s.tokens, token) // single-use: consumed even when expired
	if time.Now().After(v.expires) {
		return 0, false
	}
	return v.actorID, true
}

// handleArchiveLink issues POST /admin/api/archive/link: a short-lived
// single-use token the panel opens as a plain browser link, so the archive is
// streamed to disk by the browser instead of being buffered in the page. It is
// Owner-only (the archive holds password hashes and the key files).
func handleArchiveLink() http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromContext(r)
		token, expires, err := linkStore.issue(actor)
		if err != nil {
			slog.Error("failed to issue archive link", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create the download link")
			return
		}
		// The token is never logged — only that one was issued and for whom.
		slog.Info("archive download link issued", "actor_id", actor, "expires_at", expires.UTC())
		writeJSON(w, http.StatusOK, map[string]string{
			"token": token,
			"path":  "/admin/api/archive/download?token=" + token,
		})
	})
}

// handleArchiveDownload serves GET /admin/api/archive/download?token=…: the
// single-use link's redemption. It carries no Authorization header (a plain
// <a href> cannot send one), so the token IS the authorisation — random,
// bound to the issuing owner, single-use and short-lived. Any failure to
// redeem is a uniform 403, so a probe cannot tell unknown from expired from
// consumed.
func handleArchiveDownload(database *db.DB, opts SetupOptions) http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, ok := linkStore.redeem(r.URL.Query().Get("token"))
		if !ok {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "this download link is no longer valid")
			return
		}
		serveArchive(w, r, database, opts, actor)
	})
}
