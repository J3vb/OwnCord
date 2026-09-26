package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // G505: SHA1 required by TOTP/HOTP RFC 6238/4226
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	totpDigits      = 6
	totpPeriod      = 30 * time.Second
	partialTokenTTL = 10 * time.Minute
	enrollmentTTL   = 10 * time.Minute
)

// SecondFactorPersister is the optional durable backend behind the three
// second-factor stores — the LockoutPersister shape: stdlib types only, so
// db can implement it without importing this package back (auth imports
// db). With a persister the database is the store: every read goes to it,
// so a restart keeps an in-flight login challenge, a pending enrolment and
// the replay window (S-13, B4-3), and one process never trusts a copy
// another process has already spent. Rows never carry a secret in the
// clear: the partial-auth token and the used code arrive as SHA-256 digests
// (HashToken), and the pending enrolment secret arrives as AES-GCM
// ciphertext under the TOTP key, the same protection users.totp_secret has.
// nil means process-local, which is what tests and the memory-only
// constructors get.
type SecondFactorPersister interface {
	UpsertPartialAuth(ctx context.Context, tokenHash string, userID int64, device, ip string, failures int, expiresAt time.Time) error
	GetPartialAuth(ctx context.Context, tokenHash string) (userID int64, device, ip string, failures int, expiresAt time.Time, found bool, err error)
	// DeletePartialAuth reports whether a row was deleted, which is what makes
	// Consume single-winner across concurrent verifications.
	DeletePartialAuth(ctx context.Context, tokenHash string) (deleted bool, err error)

	UpsertPendingTOTP(ctx context.Context, userID int64, encryptedSecret string, expiresAt time.Time) error
	GetPendingTOTP(ctx context.Context, userID int64) (encryptedSecret string, expiresAt time.Time, found bool, err error)
	DeletePendingTOTP(ctx context.Context, userID int64) error

	// InsertUsedTOTPCode reports whether the row was new; false is a replay.
	InsertUsedTOTPCode(ctx context.Context, userID int64, codeHash string, expiresAt time.Time) (inserted bool, err error)
	DeleteUsedTOTPCode(ctx context.Context, userID int64, codeHash string) error
}

type PartialAuthChallenge struct {
	UserID    int64
	Device    string
	IP        string
	Failures  int
	ExpiresAt time.Time
}

// PartialAuthStore holds the login challenges Login issues when an account
// has a second factor enrolled. Memory-only unless WithPersister is set.
type PartialAuthStore struct {
	mu      syncutil.Mutex
	entries map[string]PartialAuthChallenge
	ttl     time.Duration
	persist SecondFactorPersister
}

// PendingTOTPStore holds the secret an enrolment is staged with between
// EnableTOTP and ConfirmTOTP. Memory-only unless WithPersister is set, in
// which case the secret lives in the database encrypted under key.
type PendingTOTPStore struct {
	mu      syncutil.Mutex
	entries map[int64]pendingTOTPEnrollment
	ttl     time.Duration
	persist SecondFactorPersister
	key     []byte
}

type pendingTOTPEnrollment struct {
	Secret    string
	ExpiresAt time.Time
}

func NewPartialAuthStore(ttl time.Duration) *PartialAuthStore {
	return &PartialAuthStore{
		entries: make(map[string]PartialAuthChallenge),
		ttl:     ttl,
	}
}

// WithPersister makes the database the store's backing.
func (s *PartialAuthStore) WithPersister(p SecondFactorPersister) *PartialAuthStore {
	s.persist = p
	return s
}

func NewPendingTOTPStore(ttl time.Duration) *PendingTOTPStore {
	return &PendingTOTPStore{
		entries: make(map[int64]pendingTOTPEnrollment),
		ttl:     ttl,
	}
}

// WithPersister makes the database the store's backing; key is the AES-256
// key the persisted secret is sealed under.
func (s *PendingTOTPStore) WithPersister(p SecondFactorPersister, key []byte) *PendingTOTPStore {
	s.persist = p
	s.key = key
	return s
}

// Issue creates a challenge for userID. With a persister the row is written
// before the token is handed out: a challenge that could not be persisted is
// not issued, so a restart can never lose one the client holds.
func (s *PartialAuthStore) Issue(ctx context.Context, userID int64, device, ip string) (string, error) {
	token, err := generateOpaqueToken()
	if err != nil {
		return "", err
	}
	entry := PartialAuthChallenge{
		UserID:    userID,
		Device:    device,
		IP:        ip,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	if s.persist != nil {
		if err := s.persist.UpsertPartialAuth(ctx, HashToken(token), userID, device, ip, 0, entry.ExpiresAt); err != nil {
			return "", fmt.Errorf("persisting partial-auth challenge: %w", err)
		}
		return token, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	s.entries[token] = entry
	return token, nil
}

// Lookup resolves a live challenge. A persister read failure reads as "no
// such challenge" — fail closed, the client can log in again.
func (s *PartialAuthStore) Lookup(ctx context.Context, token string) (PartialAuthChallenge, bool) {
	if s.persist != nil {
		return s.load(ctx, token)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	entry, ok := s.entries[token]
	return entry, ok
}

func (s *PartialAuthStore) load(ctx context.Context, token string) (PartialAuthChallenge, bool) {
	userID, device, ip, failures, expiresAt, found, err := s.persist.GetPartialAuth(ctx, HashToken(token))
	if err != nil {
		slog.Warn("partial-auth: reading a persisted challenge failed", "err", err)
		return PartialAuthChallenge{}, false
	}
	if !found || time.Now().After(expiresAt) {
		return PartialAuthChallenge{}, false
	}
	return PartialAuthChallenge{UserID: userID, Device: device, IP: ip, Failures: failures, ExpiresAt: expiresAt}, true
}

// Consume claims the challenge for exactly one caller. With a persister the
// row delete decides the winner; without one the map delete does.
func (s *PartialAuthStore) Consume(ctx context.Context, token string) (PartialAuthChallenge, bool) {
	if s.persist != nil {
		entry, ok := s.load(ctx, token)
		if !ok {
			return PartialAuthChallenge{}, false
		}
		deleted, err := s.persist.DeletePartialAuth(ctx, HashToken(token))
		if err != nil {
			slog.Warn("partial-auth: consuming a persisted challenge failed", "err", err)
			return PartialAuthChallenge{}, false
		}
		if !deleted {
			return PartialAuthChallenge{}, false
		}
		return entry, true
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	entry, ok := s.entries[token]
	if !ok {
		return PartialAuthChallenge{}, false
	}
	delete(s.entries, token)
	return entry, true
}

// Restore puts a challenge Consume returned back under its original token —
// the recovery path for a caller that claimed the challenge and then could
// not finish the login (OC-0378). The entry keeps its expiry and failure
// count, so a challenge that expired meanwhile is dropped by the next Lookup.
func (s *PartialAuthStore) Restore(ctx context.Context, token string, challenge PartialAuthChallenge) {
	if s.persist != nil {
		if err := s.persist.UpsertPartialAuth(ctx, HashToken(token), challenge.UserID, challenge.Device, challenge.IP, challenge.Failures, challenge.ExpiresAt); err != nil {
			slog.Warn("partial-auth: persisting a restored challenge failed", "err", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[token] = challenge
}

// RegisterFailure counts a wrong code against the challenge and reports
// whether it is still alive. The read-increment-write runs under the lock,
// so concurrent failures in one process never lose an increment.
func (s *PartialAuthStore) RegisterFailure(ctx context.Context, token string, maxFailures int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.persist != nil {
		entry, ok := s.load(ctx, token)
		if !ok {
			return false
		}
		entry.Failures++
		if entry.Failures >= maxFailures {
			if _, err := s.persist.DeletePartialAuth(ctx, HashToken(token)); err != nil {
				slog.Warn("partial-auth: deleting an exhausted challenge failed", "err", err)
			}
			return false
		}
		if err := s.persist.UpsertPartialAuth(ctx, HashToken(token), entry.UserID, entry.Device, entry.IP, entry.Failures, entry.ExpiresAt); err != nil {
			slog.Warn("partial-auth: persisting a failure count failed", "err", err)
		}
		return true
	}

	s.cleanupExpiredLocked()
	entry, ok := s.entries[token]
	if !ok {
		return false
	}
	entry.Failures++
	if entry.Failures >= maxFailures {
		delete(s.entries, token)
		return false
	}
	s.entries[token] = entry
	return true
}

func (s *PartialAuthStore) cleanupExpiredLocked() {
	now := time.Now()
	for token, entry := range s.entries {
		if now.After(entry.ExpiresAt) {
			delete(s.entries, token)
		}
	}
}

// Put stages secret for userID. With a persister the encrypted row is
// written and nothing is kept in memory; an enrolment that could not be
// persisted is not staged.
func (s *PendingTOTPStore) Put(ctx context.Context, userID int64, secret string) error {
	expiresAt := time.Now().Add(s.ttl)
	if s.persist != nil {
		sealed, err := EncryptTOTPSecret(s.key, secret)
		if err != nil {
			return fmt.Errorf("sealing pending enrolment: %w", err)
		}
		if err := s.persist.UpsertPendingTOTP(ctx, userID, sealed, expiresAt); err != nil {
			return fmt.Errorf("persisting pending enrolment: %w", err)
		}
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	s.entries[userID] = pendingTOTPEnrollment{Secret: secret, ExpiresAt: expiresAt}
	return nil
}

func (s *PendingTOTPStore) Lookup(ctx context.Context, userID int64) (string, bool) {
	if s.persist != nil {
		sealed, expiresAt, found, err := s.persist.GetPendingTOTP(ctx, userID)
		if err != nil {
			slog.Warn("pending enrolment: reading a persisted secret failed", "err", err)
			return "", false
		}
		if !found || time.Now().After(expiresAt) {
			return "", false
		}
		secret, err := DecryptTOTPSecret(s.key, sealed)
		if err != nil {
			slog.Warn("pending enrolment: unsealing a persisted secret failed", "err", err)
			return "", false
		}
		return secret, true
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	entry, ok := s.entries[userID]
	if !ok {
		return "", false
	}
	return entry.Secret, true
}

func (s *PendingTOTPStore) Delete(ctx context.Context, userID int64) {
	if s.persist != nil {
		if err := s.persist.DeletePendingTOTP(ctx, userID); err != nil {
			slog.Warn("pending enrolment: deleting a persisted secret failed", "err", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, userID)
}

func (s *PendingTOTPStore) cleanupExpiredLocked() {
	now := time.Now()
	for userID, entry := range s.entries {
		if now.After(entry.ExpiresAt) {
			delete(s.entries, userID)
		}
	}
}

// UsedTOTPCodeStore tracks recently verified TOTP codes to prevent replay
// attacks within the ±1 period validity window (~90 seconds). With a
// persister the window survives a restart, and the persisted insert is what
// decides first use.
type UsedTOTPCodeStore struct {
	mu      syncutil.Mutex
	entries map[string]time.Time // key: "userID:code" → expiry
	persist SecondFactorPersister
}

func NewUsedTOTPCodeStore() *UsedTOTPCodeStore {
	return &UsedTOTPCodeStore{
		entries: make(map[string]time.Time),
	}
}

// WithPersister makes the database the replay window's backing.
func (s *UsedTOTPCodeStore) WithPersister(p SecondFactorPersister) *UsedTOTPCodeStore {
	s.persist = p
	return s
}

func usedCodeKey(userID int64, code string) string {
	return fmt.Sprintf("%d:%s", userID, code)
}

// MarkUsed records a TOTP code as used for the given user. Returns false if
// the code was already used (replay detected) — or, with a persister, if the
// use could not be recorded: a code whose single use cannot be guaranteed is
// refused rather than accepted on trust.
func (s *UsedTOTPCodeStore) MarkUsed(ctx context.Context, userID int64, code string) bool {
	key := usedCodeKey(userID, code)
	// Codes are valid for at most 90 seconds (current period ± 1).
	expiresAt := time.Now().Add(usedTOTPCodeTTL)

	if s.persist != nil {
		inserted, err := s.persist.InsertUsedTOTPCode(ctx, userID, HashToken(key), expiresAt)
		if err != nil {
			slog.Warn("totp: recording a used code failed; refusing the code", "err", err)
			return false
		}
		return inserted
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	if _, exists := s.entries[key]; exists {
		return false // replay detected
	}
	s.entries[key] = expiresAt
	return true
}

// Unmark forgets a code MarkUsed recorded so it can be accepted once more —
// the companion of PartialAuthStore.Restore: a verification the caller could
// not complete is released together with its challenge.
func (s *UsedTOTPCodeStore) Unmark(ctx context.Context, userID int64, code string) {
	key := usedCodeKey(userID, code)
	if s.persist != nil {
		if err := s.persist.DeleteUsedTOTPCode(ctx, userID, HashToken(key)); err != nil {
			slog.Warn("totp: releasing a used code failed", "err", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, key)
}

func (s *UsedTOTPCodeStore) cleanupExpiredLocked() {
	now := time.Now()
	for key, expiry := range s.entries {
		if now.After(expiry) {
			delete(s.entries, key)
		}
	}
}

// VerifyTOTPCodeOnce verifies a TOTP code and marks it as used to prevent
// replay attacks. Returns false if the code is invalid or was already used.
func VerifyTOTPCodeOnce(ctx context.Context, secret, code string, at time.Time, userID int64, usedStore *UsedTOTPCodeStore) bool {
	if !VerifyTOTPCode(secret, code, at) {
		return false
	}
	if usedStore == nil {
		return true
	}
	return usedStore.MarkUsed(ctx, userID, code)
}

func GenerateTOTPSecret() (string, error) {
	bytes := make([]byte, totpSecretBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("GenerateTOTPSecret: %w", err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(bytes), nil
}

func BuildTOTPURI(username, secret, issuer string) string {
	label := url.PathEscape(issuer + ":" + username)
	query := url.Values{}
	query.Set("secret", secret)
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", fmt.Sprintf("%d", totpDigits))
	query.Set("period", fmt.Sprintf("%d", int(totpPeriod.Seconds())))
	return fmt.Sprintf("otpauth://totp/%s?%s", label, query.Encode())
}

func GenerateTOTPCode(secret string, at time.Time) (string, error) {
	secret = strings.ToUpper(strings.TrimSpace(secret))
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		return "", fmt.Errorf("GenerateTOTPCode: %w", err)
	}

	counter := uint64(at.UTC().Unix() / int64(totpPeriod.Seconds())) //nolint:gosec // G115: TOTP counter is always positive
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, counter)

	h := hmac.New(sha1.New, decoded)
	_, _ = h.Write(buf)
	sum := h.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", binaryCode%1000000), nil
}

func VerifyTOTPCode(secret, code string, at time.Time) bool {
	if len(code) != totpDigits {
		return false
	}
	for _, offset := range []int{-1, 0, 1} {
		candidate, err := GenerateTOTPCode(secret, at.Add(time.Duration(offset)*totpPeriod))
		if err == nil && subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func generateOpaqueToken() (string, error) {
	bytes := make([]byte, opaqueTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generateOpaqueToken: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}
