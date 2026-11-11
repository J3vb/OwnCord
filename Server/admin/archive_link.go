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
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/go-chi/chi/v5"
)

// archiveLinkTTL is how long a single-use link stays valid; short because the browser opens it at once and a
// leaked link is near-useless.
var archiveLinkTTL = 60 * time.Second

// archiveLink is one issued, unused link token. tokenHash is the requesting bearer credential's hash,
// re-resolved on redemption so a revoked session, ban or lost Owner role voids the link; target names the one
// file a backup link opens (empty for the archive).
type archiveLink struct {
	actorID   int64
	tokenHash string
	target    string
	expires   time.Time
}

// archiveLinks holds outstanding tokens in process: a restart voids them, the safe direction.
type archiveLinks struct {
	mu     syncutil.Mutex
	tokens map[string]archiveLink
}

// Two stores (archive, single backup), so a token minted for one route is unknown to the other and a probe
// there cannot spend it.
var (
	linkStore       = &archiveLinks{tokens: make(map[string]archiveLink)}
	backupLinkStore = &archiveLinks{tokens: make(map[string]archiveLink)}
)

// issue mints a random single-use token bound to actorID, credential hash and target, expiring after
// archiveLinkTTL; never logged.
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

// redeem consumes a token and reports whether it was valid and unexpired; deleted on first use, so it can
// never work twice.
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

// handleArchiveLink issues POST /admin/api/archive/link: a single-use token the panel opens as a plain
// browser link so the archive streams to disk. Owner or RESTORE_BACKUPS holder (the archive holds password
// hashes and key files); audited as archive_link.
func handleArchiveLink(database *db.DB) http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash, ok := linkCredentialHash(w, r)
		if !ok {
			return
		}
		// Refused here too so the panel can show why, not a bare failed download.
		if archiveBusy.Load() {
			writeArchiveBusy(w)
			return
		}
		actor := actorFromContext(r)
		token, expires := linkStore.issue(actor, hash, "")
		// The token is never logged — only that one was issued and for whom.
		slog.Info("archive download link issued", "actor_id", actor, "expires_at", expires.UTC())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "archive_link", "server", 0,
			"issued a download link for the full archive")
		writeJSON(w, http.StatusOK, map[string]string{
			"path": "/admin/api/archive/download?token=" + token,
		})
	})
}

// handleArchiveDownload serves the single-use link's redemption. It carries no Authorization header (a plain
// <a href> cannot), so the token stands in: random, single-use, short-lived, and the credential that asked
// must still resolve to a non-banned Owner or RESTORE_BACKUPS holder (linkRestoreStillValid). Any failure to
// redeem is a uniform 403, so a probe cannot tell unknown from expired from consumed from revoked.
func handleArchiveDownload(database *db.DB, opts SetupOptions, paths backupPaths) http.HandlerFunc {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		link, ok := linkStore.redeem(r.URL.Query().Get("token"))
		if !ok || !linkRestoreStillValid(r, database, link) {
			writeLinkInvalid(w)
			return
		}
		serveArchive(w, r, database, opts, paths, link.actorID)
	})
}

// linkCredentialHash reads the hash of the bearer credential the auth middleware resolved, the one a link
// binds to.
func linkCredentialHash(w http.ResponseWriter, r *http.Request) (string, bool) {
	hash, ok := r.Context().Value(adminTokenHashKey).(string)
	if !ok || hash == "" {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired session")
		return "", false
	}
	return hash, true
}

// linkRestoreStillValid re-resolves the credential a link was issued to: still a live session or token of a
// non-banned principal who is the Owner or holds RESTORE_BACKUPS, judged on effective permissions at
// redemption. Losing the bit, a ban or a sign-out since issue gets nothing; an Administrator without the bit
// never did.
func linkRestoreStillValid(r *http.Request, database *db.DB, link archiveLink) bool {
	return linkPrincipalStillValid(r, database, link, func(role *db.Role) bool {
		return permissions.CanRestoreBackups(role.Permissions, role.ID, role.Position)
	})
}

// linkBackupStillValid is linkRestoreStillValid for a single backup's link, with MANAGE_BACKUPS.
// ResolveTokenHash's role carries the OR of every held role's permissions, as the admin perimeter does.
func linkBackupStillValid(r *http.Request, database *db.DB, link archiveLink) bool {
	return linkPrincipalStillValid(r, database, link, func(role *db.Role) bool {
		return permissions.CanManageBackups(role.Permissions, role.ID, role.Position)
	})
}

func linkPrincipalStillValid(r *http.Request, database *db.DB, link archiveLink, allow func(*db.Role) bool) bool {
	user, role, _, err := auth.ResolveTokenHash(r.Context(), database, link.tokenHash)
	return err == nil && user != nil && role != nil && !auth.IsEffectivelyBanned(user) && allow(role)
}

// writeLinkInvalid is the one refusal every failed redemption answers, so a probe cannot tell the causes
// apart.
func writeLinkInvalid(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "this download link is no longer valid")
}

// handleBackupLink issues a single-use link to download one backup, on the archive link's pattern. Owner or
// MANAGE_BACKUPS holder (a backup holds every account's password hash, so only the owner can grant the bit);
// audited as backup_link.
func handleBackupLink(database *db.DB, paths backupPaths) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hash, ok := linkCredentialHash(w, r)
		if !ok {
			return
		}
		name, target, ok := resolveBackupName(w, r, paths.dir)
		if !ok {
			return
		}
		if info, err := os.Stat(target); err != nil || !info.Mode().IsRegular() || filepath.Ext(name) != ".db" { //nolint:gosec // G703: path sanitized by resolveBackupName
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "backup not found")
			return
		}
		actor := actorFromContext(r)
		token, expires := backupLinkStore.issue(actor, hash, name)
		slog.Info("backup download link issued", "actor_id", actor, "name", name, "expires_at", expires.UTC())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_link", "server", 0,
			"issued a download link for backup "+name)
		writeJSON(w, http.StatusOK, map[string]string{
			"path": "/admin/api/backups/" + url.PathEscape(name) + "/download?token=" + token,
		})
	}
}

// handleBackupDownload is the backup link's redemption: credential re-checked as Owner or MANAGE_BACKUPS
// holder (linkBackupStillValid), token spent on the first attempt and valid only for its file, streamed from
// disk, never read into memory.
func handleBackupDownload(database *db.DB, paths backupPaths) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		link, ok := backupLinkStore.redeem(r.URL.Query().Get("token"))
		if !ok || link.target == "" || link.target != name || !linkBackupStillValid(r, database, link) {
			writeLinkInvalid(w)
			return
		}
		f, err := openBackupEntry(paths.dir, link.target)
		if err != nil {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "backup not found")
			return
		}
		defer f.Close() //nolint:errcheck
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "backup not found")
			return
		}

		// Armed before the headers and the audit write, so the whole response is under the progress deadline, not
		// the server's 30 s WriteTimeout. The token is already spent: a transfer failing partway needs a new link.
		deadline := startArchive(w, r, func() {}, archiveProgressTimeout, archiveMaxLifetime)
		defer deadline.release()
		deadline.touch()

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		slog.Info("backup downloaded", "actor_id", link.actorID, "name", name, "bytes", info.Size())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, link.actorID, "backup_download", "server", 0,
			fmt.Sprintf("downloaded backup %s (%d bytes)", name, info.Size()))

		if _, err := io.Copy(deadline, f); err != nil {
			slog.Warn("backup download interrupted", "name", name, "err", err)
		}
	}
}

// openBackupEntry opens the directory entry named name. The path comes from the listing's own entry, never
// request input, so nothing a caller sends can steer it outside the backup directory.
func openBackupEntry(backupDir, name string) (*os.File, error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.Type().IsRegular() && e.Name() == name {
			return os.Open(filepath.Join(backupDir, e.Name())) //nolint:gosec // G304: an entry of the backup directory itself
		}
	}
	return nil, os.ErrNotExist
}
