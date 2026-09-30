package admin

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// archiveLinkTTL is how long a single-use archive link stays valid. It is
// short by design: the owner asks for it and the browser opens it immediately,
// so a minute is generous and a leaked link is near-useless.
var archiveLinkTTL = 60 * time.Second

// archiveLink is one issued, not-yet-used link token. tokenHash is the hash
// of the bearer credential that asked for it, re-resolved on redemption so a
// revoked session, a ban or a lost Owner role voids the link.
type archiveLink struct {
	actorID   int64
	tokenHash string
	expires   time.Time
}

// archiveLinks holds the outstanding single-use tokens. It is process-local:
// a restart voids every outstanding link, which is the safe direction.
type archiveLinks struct {
	mu     syncutil.Mutex
	tokens map[string]archiveLink
}

var linkStore = &archiveLinks{tokens: make(map[string]archiveLink)}

// issue mints a random single-use token bound to actorID and the credential
// hash, expiring after archiveLinkTTL. The token is never logged.
func (s *archiveLinks) issue(actorID int64, tokenHash string) (string, time.Time) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
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
	expires := now.Add(archiveLinkTTL)
	s.tokens[token] = archiveLink{actorID: actorID, tokenHash: tokenHash, expires: expires}
	return token, expires
}

// redeem consumes a token, returning its link and whether it was valid and
// unexpired. A token is deleted on first use, so it can never work twice.
func (s *archiveLinks) redeem(token string) (archiveLink, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.tokens[token]
	if !ok {
		return archiveLink{}, false
	}
	delete(s.tokens, token) // single-use: consumed even when expired
	if time.Now().After(v.expires) {
		return archiveLink{}, false
	}
	return v, true
}

// handleArchiveLink issues POST /admin/api/archive/link: a short-lived
// single-use token the panel opens as a plain browser link, so the archive is
// streamed to disk by the browser instead of being buffered in the page. It is
// Owner-only (the archive holds password hashes and the key files).
func handleArchiveLink() http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash, ok := r.Context().Value(adminTokenHashKey).(string)
		if !ok || hash == "" {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
			return
		}
		// Refused here too, so the panel can show why instead of the browser
		// reporting a bare failed download.
		if archiveBusy.Load() {
			writeArchiveBusy(w)
			return
		}
		actor := actorFromContext(r)
		token, expires := linkStore.issue(actor, hash)
		// The token is never logged — only that one was issued and for whom.
		slog.Info("archive download link issued", "actor_id", actor, "expires_at", expires.UTC())
		writeJSON(w, http.StatusOK, map[string]string{
			"path": "/admin/api/archive/download?token=" + token,
		})
	})
}

// handleArchiveDownload serves GET /admin/api/archive/download?token=…: the
// single-use link's redemption. It carries no Authorization header (a plain
// <a href> cannot send one), so the token stands in for it: random,
// single-use and short-lived, and the credential that asked for it must
// still resolve to a non-banned Owner. Any failure to redeem is a uniform
// 403, so a probe cannot tell unknown from expired from consumed from revoked.
func handleArchiveDownload(database *db.DB, opts SetupOptions) http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		link, ok := linkStore.redeem(r.URL.Query().Get("token"))
		if ok {
			user, role, _, err := auth.ResolveTokenHash(r.Context(), database, link.tokenHash)
			ok = err == nil && user != nil && role != nil && !auth.IsEffectivelyBanned(user) &&
				permissions.IsOwner(role.ID, role.Position)
		}
		if !ok {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "this download link is no longer valid")
			return
		}
		serveArchive(w, r, database, opts, link.actorID)
	})
}
