package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	totpDigits      = 6
	totpPeriod      = 30 * time.Second
	partialTokenTTL = 10 * time.Minute
	enrollmentTTL   = 10 * time.Minute
)

type PartialAuthChallenge struct {
	UserID    int64
	Device    string
	IP        string
	Failures  int
	ExpiresAt time.Time
}

type PartialAuthStore struct {
	mu      sync.Mutex
	entries map[string]PartialAuthChallenge
	ttl     time.Duration
}

type PendingTOTPStore struct {
	mu      sync.Mutex
	entries map[int64]pendingTOTPEnrollment
	ttl     time.Duration
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

func NewPendingTOTPStore(ttl time.Duration) *PendingTOTPStore {
	return &PendingTOTPStore{
		entries: make(map[int64]pendingTOTPEnrollment),
		ttl:     ttl,
	}
}

func (s *PartialAuthStore) Issue(userID int64, device, ip string) (string, error) {
	token, err := generateOpaqueToken()
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	s.entries[token] = PartialAuthChallenge{
		UserID:    userID,
		Device:    device,
		IP:        ip,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	return token, nil
}

func (s *PartialAuthStore) Lookup(token string) (PartialAuthChallenge, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	entry, ok := s.entries[token]
	return entry, ok
}

func (s *PartialAuthStore) Consume(token string) (PartialAuthChallenge, bool) {
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

func (s *PartialAuthStore) RegisterFailure(token string, maxFailures int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
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

func (s *PendingTOTPStore) Put(userID int64, secret string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	s.entries[userID] = pendingTOTPEnrollment{
		Secret:    secret,
		ExpiresAt: time.Now().Add(s.ttl),
	}
}

func (s *PendingTOTPStore) Lookup(userID int64) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupExpiredLocked()
	entry, ok := s.entries[userID]
	if !ok {
		return "", false
	}
	return entry.Secret, true
}

func (s *PendingTOTPStore) Delete(userID int64) {
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

func GenerateTOTPSecret() (string, error) {
	bytes := make([]byte, 20)
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

	counter := uint64(at.UTC().Unix() / int64(totpPeriod.Seconds()))
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
		if err == nil && candidate == code {
			return true
		}
	}
	return false
}

func generateOpaqueToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generateOpaqueToken: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}
