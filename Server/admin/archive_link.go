package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/go-chi/chi/v5"
)

// archiveLinkTTL is how long a single-use archive link stays valid. It is
// short by design: the owner asks for it and the browser opens it immediately,
// so a minute is generous and a leaked link is near-useless.
var archiveLinkTTL = 60 * time.Second

// archiveLink is one issued, not-yet-used link token. tokenHash is the hash
// of the bearer credential that asked for it, re-resolved on redemption so a
// revoked session, a ban or a lost Owner role voids the link. target names
// the one file a backup link opens; it is empty for the archive.
type archiveLink struct {
	actorID   int64
	tokenHash string
	target    string
	expires   time.Time
}

// archiveLinks holds the outstanding single-use tokens. It is process-local:
// a restart voids every outstanding link, which is the safe direction.
type archiveLinks struct {
	mu     syncutil.Mutex
	tokens map[string]archiveLink
}

// linkStore holds the archive's links and backupLinkStore a single backup's.
// Two stores, so a token minted for one route is unknown to the other and a
// probe there cannot spend it.
var (
	linkStore       = &archiveLinks{tokens: make(map[string]archiveLink)}
	backupLinkStore = &archiveLinks{tokens: make(map[string]archiveLink)}
)

// issue mints a random single-use token bound to actorID, the credential
// hash and target, expiring after archiveLinkTTL. The token is never logged.
func (s *archiveLinks) issue(actorID int64, tokenHash, target string) (string, time.Time) {
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
	s.tokens[token] = archiveLink{actorID: actorID, tokenHash: tokenHash, target: target, expires: expires}
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
		hash, ok := linkCredentialHash(w, r)
		if !ok {
			return
		}
		// Refused here too, so the panel can show why instead of the browser
		// reporting a bare failed download.
		if archiveBusy.Load() {
			writeArchiveBusy(w)
			return
		}
		actor := actorFromContext(r)
		token, expires := linkStore.issue(actor, hash, "")
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
		if !ok || !linkOwnerStillValid(r, database, link) {
			writeLinkInvalid(w)
			return
		}
		serveArchive(w, r, database, opts, link.actorID)
	})
}

// linkCredentialHash reads the hash of the bearer credential the admin auth
// middleware resolved, the one a link is bound to.
func linkCredentialHash(w http.ResponseWriter, r *http.Request) (string, bool) {
	hash, ok := r.Context().Value(adminTokenHashKey).(string)
	if !ok || hash == "" {
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
		return "", false
	}
	return hash, true
}

// linkOwnerStillValid re-resolves the credential a link was issued to: it
// must still be a live session or token of a non-banned Owner.
func linkOwnerStillValid(r *http.Request, database *db.DB, link archiveLink) bool {
	user, role, _, err := auth.ResolveTokenHash(r.Context(), database, link.tokenHash)
	return err == nil && user != nil && role != nil && !auth.IsEffectivelyBanned(user) &&
		permissions.IsOwner(role.ID, role.Position)
}

// writeLinkInvalid is the one refusal every failed redemption answers, so a
// probe cannot tell unknown from expired from consumed from revoked.
func writeLinkInvalid(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "FORBIDDEN", "this download link is no longer valid")
}

// handleBackupLink issues POST /admin/api/backups/{name}/link: a single-use
// link to download that one backup, on the archive link's pattern — random,
// bound to the Owner credential that asked, expiring after archiveLinkTTL,
// never logged. Owner-only like restore: a backup holds every account's
// password hash.
func handleBackupLink() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hash, ok := linkCredentialHash(w, r)
		if !ok {
			return
		}
		name, target, ok := resolveBackupName(w, r)
		if !ok {
			return
		}
		if info, err := os.Stat(target); err != nil || !info.Mode().IsRegular() || filepath.Ext(name) != ".db" { //nolint:gosec // G703: path sanitized by resolveBackupName
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}
		actor := actorFromContext(r)
		token, expires := backupLinkStore.issue(actor, hash, name)
		slog.Info("backup download link issued", "actor_id", actor, "name", name, "expires_at", expires.UTC())
		writeJSON(w, http.StatusOK, map[string]string{
			"path": "/admin/api/backups/" + url.PathEscape(name) + "/download?token=" + token,
		})
	}
}

// handleBackupDownload serves GET /admin/api/backups/{name}/download?token=…,
// the backup link's redemption. The token is spent on the first attempt and
// opens only the file it was issued for; the file is streamed from disk, never
// read into memory.
func handleBackupDownload(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		link, ok := backupLinkStore.redeem(r.URL.Query().Get("token"))
		if !ok || link.target == "" || link.target != name || !linkOwnerStillValid(r, database, link) {
			writeLinkInvalid(w)
			return
		}
		f, err := os.Open(filepath.Join(backupBaseDir, name)) //nolint:gosec // G304: name was validated when the link was issued
		if err != nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}
		defer f.Close() //nolint:errcheck
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		slog.Info("backup downloaded", "actor_id", link.actorID, "name", name, "bytes", info.Size())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, link.actorID, "backup_download", "server", 0,
			fmt.Sprintf("downloaded backup %s (%d bytes)", name, info.Size()))

		if _, err := io.Copy(w, f); err != nil {
			slog.Warn("backup download interrupted", "name", name, "err", err)
		}
	}
}
