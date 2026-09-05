package service

import (
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// maxPushSubscriptionsPerUser bounds how many devices one account may keep
// subscribed at once; the 11th subscription evicts the oldest by
// last_seen_at (B5-4, plan decision 4).
//
// ponytail: constant; make it a bounded key when an operator asks.
const maxPushSubscriptionsPerUser = 10

const (
	// pushDefaultTTL is the staleness window used when no TTL has been
	// installed (or an install of 0/negative asked for the default).
	pushDefaultTTL = 90 * 24 * time.Hour
	// pushMaxEndpointLen bounds the push endpoint URL.
	pushMaxEndpointLen = 2048
	// pushMaxDeviceNameRunes bounds the operator/UI-facing device label.
	pushMaxDeviceNameRunes = 64
	// pushP256dhLen / pushAuthLen are the Web Push credential shapes: a
	// 65-byte uncompressed P-256 point (0x04 prefix) and a 16-byte auth
	// secret.
	pushP256dhLen = 65
	pushAuthLen   = 16
)

// ErrInvalidSubscription wraps every reason Subscribe refuses an input;
// handlers answer 400 INVALID_INPUT.
var ErrInvalidSubscription = errors.New("invalid push subscription")

// PushSubscribeInput is the caller-supplied shape Subscribe validates. There
// is no user id here on purpose: the row's owner is always the session's.
type PushSubscribeInput struct {
	Endpoint   string
	P256dh     string
	Auth       string
	DeviceName string
}

// PushService stores Web Push subscriptions (migration 045, B5-4). Nothing
// here dispatches a push — that is B5-11, behind HP-5. Rotation is an
// operator action (replace the VAPID key file or env var, then restart),
// not a method on this service: SetVAPIDKey is called once, at start-up.
type PushService struct {
	st Store

	mu     syncutil.Mutex
	priv   *ecdh.PrivateKey
	pubB64 string
	keyID  string
	ttl    time.Duration
}

// NewPushService constructs a PushService with no key installed yet
// (PublicKey reports ok=false) and the default 90-day staleness window.
func NewPushService(st Store) *PushService {
	return &PushService{st: st, ttl: pushDefaultTTL}
}

// SetVAPIDKey installs the running VAPID key. The composition root calls
// this once at start-up, unconditionally — regardless of push.enabled,
// because the sweep needs the key id to recognise (and remove) rows a
// rotation orphaned even while the feature is off. A nil key clears it back
// to the not-installed state.
func (s *PushService) SetVAPIDKey(priv *ecdh.PrivateKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.priv = priv
	if priv == nil {
		s.pubB64, s.keyID = "", ""
		return
	}
	pub := priv.PublicKey().Bytes()
	s.pubB64 = base64.RawURLEncoding.EncodeToString(pub)
	sum := sha256.Sum256(pub)
	s.keyID = hex.EncodeToString(sum[:8])
}

// SetSubscriptionTTL installs the staleness window Sweep uses. d <= 0 means
// "use the default", so an un-set config value cannot silently disable the
// sweep.
func (s *PushService) SetSubscriptionTTL(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d <= 0 {
		d = pushDefaultTTL
	}
	s.ttl = d
}

// PublicKey returns the running key's public bytes — base64url, no padding,
// the 65-byte uncompressed point — and its key id, the hex of the first 8
// bytes of SHA-256(public key bytes). ok is false until a key is installed.
func (s *PushService) PublicKey() (publicKeyB64URL, keyID string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pubB64, s.keyID, s.priv != nil
}

func (s *PushService) currentKeyID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.keyID
}

func (s *PushService) currentTTL() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ttl
}

// Subscribe validates in, then upserts the row for userID under the running
// VAPID key id and trims the user's rows to the device cap, evicting the
// oldest by last_seen_at. Re-subscribing the same endpoint is the refresh
// path: the upsert bumps last_seen_at rather than adding a row.
func (s *PushService) Subscribe(ctx context.Context, userID int64, in PushSubscribeInput) (int64, error) {
	p256dh, auth, deviceName, err := validatePushSubscription(in)
	if err != nil {
		return 0, err
	}
	id, err := s.st.UpsertPushSubscription(ctx, userID, in.Endpoint, p256dh, auth, deviceName, s.currentKeyID(), maxPushSubscriptionsPerUser)
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return id, nil
}

// List returns userID's subscriptions under the running VAPID key. A row
// written under a since-rotated key is invisible here (decision 2) — the
// sweep is what removes it.
func (s *PushService) List(ctx context.Context, userID int64) ([]db.PushSubscription, error) {
	rows, err := s.st.ListPushSubscriptions(ctx, userID, s.currentKeyID())
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// Revoke deletes id, scoped to userID so one user can never revoke
// another's subscription by guessing an id. ErrNotFound when the id does
// not exist or belongs to someone else.
func (s *PushService) Revoke(ctx context.Context, userID, id int64) error {
	ok, err := s.st.DeletePushSubscription(ctx, userID, id)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// Sweep deletes every subscription past the staleness window and, once a
// key is installed, every subscription whose vapid_key_id no longer
// matches it — the staleness sweep and the rotation sweep in one pass
// (decisions 2 and 5). With no key installed it sweeps by time only.
func (s *PushService) Sweep(ctx context.Context) (int64, error) {
	cutoff := time.Now().Add(-s.currentTTL())
	n, err := s.st.SweepPushSubscriptions(ctx, cutoff, s.currentKeyID())
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return n, nil
}

// validatePushSubscription checks in and returns the canonical (decoded and
// re-encoded raw-url-base64) forms of the credential fields the row stores.
func validatePushSubscription(in PushSubscribeInput) (p256dh, auth, deviceName string, err error) {
	if len(in.Endpoint) > pushMaxEndpointLen {
		return "", "", "", fmt.Errorf("%w: endpoint is too long", ErrInvalidSubscription)
	}
	u, perr := url.Parse(in.Endpoint)
	if perr != nil || u.Scheme != "https" || u.Hostname() == "" {
		return "", "", "", fmt.Errorf("%w: endpoint must be an https URL with a host", ErrInvalidSubscription)
	}
	if u.User != nil {
		return "", "", "", fmt.Errorf("%w: endpoint must not carry credentials", ErrInvalidSubscription)
	}

	p256dhBytes, decErr := decodePushBase64(in.P256dh)
	if decErr != nil || len(p256dhBytes) != pushP256dhLen || p256dhBytes[0] != 0x04 {
		return "", "", "", fmt.Errorf("%w: p256dh must be a 65-byte uncompressed P-256 point", ErrInvalidSubscription)
	}
	authBytes, authErr := decodePushBase64(in.Auth)
	if authErr != nil || len(authBytes) != pushAuthLen {
		return "", "", "", fmt.Errorf("%w: auth must be 16 bytes", ErrInvalidSubscription)
	}

	if utf8.RuneCountInString(in.DeviceName) > pushMaxDeviceNameRunes {
		return "", "", "", fmt.Errorf("%w: device_name is too long", ErrInvalidSubscription)
	}
	for _, r := range in.DeviceName {
		if unicode.IsControl(r) {
			return "", "", "", fmt.Errorf("%w: device_name must not contain control characters", ErrInvalidSubscription)
		}
	}

	return base64.RawURLEncoding.EncodeToString(p256dhBytes),
		base64.RawURLEncoding.EncodeToString(authBytes),
		in.DeviceName, nil
}

// decodePushBase64 accepts both padded and unpadded base64url, by trimming
// any "=" padding before decoding with the raw (unpadded) encoding — a
// browser's PushSubscription.toJSON() and various client libraries disagree
// on which form they emit.
func decodePushBase64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
