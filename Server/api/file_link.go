package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/go-chi/chi/v5"
)

// File links let a <video> element stream an attachment with Range requests
// without an Authorization header, which a media element cannot send. A client
// asks for one with POST /api/v1/files/{id}/link and opens the returned path.
//
// A link is multi-use until it expires (a player makes many Range requests),
// bound to one file id and to the credential hash that asked for it. Every
// use re-resolves that credential through resolvePrincipal and re-runs the
// ordinary file access rule, so signing out, a ban, an expired session or a
// lost channel role voids it at once. The token is never logged.

// fileLinkTTL is how long a minted link stays valid.
var fileLinkTTL = time.Hour

// fileLinkMaxEntries bounds the link map. Past it the soonest-expiring link is
// dropped to make room, so a flood of mints cannot grow memory without limit.
const fileLinkMaxEntries = 10000

// fileLinkMaxPerCredential bounds the links one credential holds.
const fileLinkMaxPerCredential = 64

// fileLinkRateLimitPerMinute is the per-user cap on link requests: a page of
// videos mints one each, so it is generous.
const fileLinkRateLimitPerMinute = 600

// fileLinkReuseMargin is how much life a kept link must have left for a
// second mint by the same credential for the same file to hand it out again.
const fileLinkReuseMargin = 10 * time.Minute

// fileLinkQueryParam is the query parameter that carries the token.
const fileLinkQueryParam = "link"

// fileLinkKey identifies who a link was minted for: one credential, one file.
type fileLinkKey struct {
	fileID    string
	tokenHash string
}

// fileLink is one outstanding link token.
type fileLink struct {
	key     fileLinkKey
	expires time.Time
}

// fileLinks holds the outstanding links. It is process-local: a restart voids
// every link, which is the safe direction.
type fileLinks struct {
	mu     syncutil.Mutex
	tokens map[string]fileLink
	byKey  map[fileLinkKey]string
	now    func() time.Time
}

func newFileLinks() *fileLinks {
	return &fileLinks{
		tokens: make(map[string]fileLink),
		byKey:  make(map[fileLinkKey]string),
		now:    time.Now,
	}
}

// issue returns a token for (fileID, tokenHash) and its expiry. A credential
// asking again for the same file gets its existing link while it has
// fileLinkReuseMargin left, so one viewer re-rendering a message cannot fill
// the map.
func (s *fileLinks) issue(fileID, tokenHash string) (string, time.Time, error) {
	key := fileLinkKey{fileID: fileID, tokenHash: tokenHash}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if tok, ok := s.byKey[key]; ok {
		if l, live := s.tokens[tok]; live && l.expires.Sub(now) > fileLinkReuseMargin {
			return tok, l.expires, nil
		}
	}
	// Opportunistic sweep of expired links so the map cannot grow unbounded.
	for tok, l := range s.tokens {
		if !now.Before(l.expires) {
			s.dropLocked(tok)
		}
	}
	// One credential holds at most fileLinkMaxPerCredential links; past it
	// that credential's own soonest-expiring link goes first.
	for s.countLocked(tokenHash) >= fileLinkMaxPerCredential {
		s.dropLocked(s.soonestLocked(tokenHash))
	}
	for len(s.tokens) >= fileLinkMaxEntries {
		s.dropLocked(s.soonestLocked(""))
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, fmt.Errorf("file link token: %w", err)
	}
	tok := hex.EncodeToString(b)
	expires := now.Add(fileLinkTTL)
	// A replaced link is left to expire (the sweep bounds it): a player that
	// was handed it a moment ago keeps working.
	s.tokens[tok] = fileLink{key: key, expires: expires}
	s.byKey[key] = tok
	return tok, expires, nil
}

// countLocked is how many links tokenHash holds. s.mu must be held.
func (s *fileLinks) countLocked(tokenHash string) int {
	n := 0
	for _, l := range s.tokens {
		if l.key.tokenHash == tokenHash {
			n++
		}
	}
	return n
}

// soonestLocked is the soonest-expiring token of tokenHash, or of everyone
// when tokenHash is empty. s.mu must be held.
func (s *fileLinks) soonestLocked(tokenHash string) string {
	var soonest string
	var soonestExp time.Time
	for tok, l := range s.tokens {
		if tokenHash != "" && l.key.tokenHash != tokenHash {
			continue
		}
		if soonest == "" || l.expires.Before(soonestExp) {
			soonest, soonestExp = tok, l.expires
		}
	}
	return soonest
}

// dropLocked removes a token and its reverse index entry. s.mu must be held.
func (s *fileLinks) dropLocked(tok string) {
	l, ok := s.tokens[tok]
	if !ok {
		return
	}
	delete(s.tokens, tok)
	if s.byKey[l.key] == tok {
		delete(s.byKey, l.key)
	}
}

// lookup returns the credential hash a token was minted for when it is
// unexpired and names fileID. An expired token is removed.
func (s *fileLinks) lookup(token, fileID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.tokens[token]
	if !ok {
		return "", false
	}
	if !s.now().Before(l.expires) {
		s.dropLocked(token)
		return "", false
	}
	if l.key.fileID != fileID {
		return "", false
	}
	return l.key.tokenHash, true
}

// size is the number of outstanding links, for tests.
func (s *fileLinks) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tokens)
}

// fileLinkResponse is the body of POST /api/v1/files/{id}/link.
type fileLinkResponse struct {
	Path      string `json:"path"`
	ExpiresAt string `json:"expires_at"`
}

// handleIssueFileLink answers POST /api/v1/files/{id}/link: a link to the file
// for the caller, under exactly the access rule the download applies. It runs
// behind AuthMiddleware, so the link is bound to the bearer credential used.
func handleIssueFileLink(uploads *service.UploadService, links *fileLinks, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		if !limiter.Allow(auth.Key("file_link", user.ID), fileLinkRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many file link requests, try again shortly")
			return
		}
		if _, ok := authorizeFileRead(w, r, uploads); !ok {
			return
		}
		token, ok := auth.ExtractBearerToken(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}
		fileID := chi.URLParam(r, "id")
		tok, expires, err := links.issue(fileID, auth.HashToken(token))
		if err != nil {
			slog.ErrorContext(r.Context(), "file link token generation failed", "error", err)
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "could not create a file link")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, fileLinkResponse{
			Path:      "/api/v1/files/" + url.PathEscape(fileID) + "?" + fileLinkQueryParam + "=" + tok,
			ExpiresAt: expires.UTC().Format(time.RFC3339),
		})
	}
}

// fileLinkAuth is the authentication for GET /api/v1/files/{id}. A request
// with an Authorization header, or without a link, is AuthMiddleware's as
// before. Otherwise the link must exist, be unexpired and name this file; the
// credential it was minted for is then re-resolved through resolvePrincipal.
// Every refusal is the same 403, so a probe learns nothing about which part
// failed. A database outage is the one exception: 503, as on the bearer path.
func fileLinkAuth(sessions *service.SessionService, links *fileLinks) func(http.Handler) http.Handler {
	bearer := AuthMiddleware(sessions)
	touches := &touchThrottle{seen: make(map[string]time.Time)}
	return func(next http.Handler) http.Handler {
		viaBearer := bearer(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.URL.Query().Get(fileLinkQueryParam)
			if r.Header.Get("Authorization") != "" || token == "" {
				viaBearer.ServeHTTP(w, r)
				return
			}
			hash, ok := links.lookup(token, chi.URLParam(r, "id"))
			if !ok {
				writeFileLinkRefused(w)
				return
			}
			ctx, fail := resolvePrincipal(r.Context(), sessions, touches, hash)
			if fail != nil {
				if fail.status == http.StatusServiceUnavailable {
					writeErr(w, fail.status, fail.code, fail.message)
				} else {
					writeFileLinkRefused(w)
				}
				if fail.after != nil {
					fail.after()
				}
				return
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// writeFileLinkRefused is the one answer to every link failure.
func writeFileLinkRefused(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "this file link is not valid")
}
