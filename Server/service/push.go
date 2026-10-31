package service

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// maxPushSubscriptionsPerUser bounds the devices one account may keep subscribed;
// the 11th evicts the oldest by last_seen_at.
const maxPushSubscriptionsPerUser = 10

const (
	// pushDefaultTTL is the staleness window when no TTL (or 0/negative) is installed.
	pushDefaultTTL         = 90 * 24 * time.Hour
	pushMaxEndpointLen     = 2048
	pushMaxDeviceNameRunes = 64
	// pushP256dhLen / pushAuthLen are the Web Push credential shapes: a 65-byte
	// uncompressed P-256 point (0x04 prefix) and a 16-byte auth secret.
	pushP256dhLen = 65
	pushAuthLen   = 16
)

// ErrInvalidSubscription wraps every reason Subscribe refuses an input; handlers
// answer 400 INVALID_INPUT.
var ErrInvalidSubscription = errors.New("invalid push subscription")

// PushSubscribeInput is the shape Subscribe validates. It has no user id on
// purpose: the row's owner is always the session's.
type PushSubscribeInput struct {
	Endpoint   string
	P256dh     string
	Auth       string
	DeviceName string
}

// pushStore is what PushService reads and writes. *db.DB satisfies it.
type pushStore interface {
	// UpsertPushSubscription's keep is the per-user device cap; upsert, eviction
	// ranking and eviction delete run in one transaction.
	UpsertPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth, deviceName, keyID string, keep int) (int64, error)
	ListPushSubscriptions(ctx context.Context, userID int64, keyID string) ([]db.PushSubscription, error)
	DeletePushSubscription(ctx context.Context, userID, id int64) (bool, error)
	SweepPushSubscriptions(ctx context.Context, cutoff time.Time, keyID string) (int64, error)
}

// PushService stores Web Push subscriptions; dispatching is PushDispatcher's job.
// VAPID rotation is an operator action (replace the key file or env var, restart),
// not a method: SetVAPIDKey is called once, at start-up.
type PushService struct {
	st pushStore

	mu      syncutil.Mutex
	priv    *ecdh.PrivateKey
	pubB64  string
	keyID   string
	ttl     time.Duration
	contact string
}

// NewPushService constructs a PushService with no key installed (PublicKey
// reports ok=false) and the default 90-day staleness window.
func NewPushService(st pushStore) *PushService {
	return &PushService{st: st, ttl: pushDefaultTTL}
}

// SetVAPIDKey installs the running VAPID key. The root calls it once at start-up
// regardless of push.enabled: the sweep needs the key id to remove rows a rotation
// orphaned even while the feature is off. A nil key clears it.
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

// SetSubscriptionTTL installs the staleness window Sweep uses; d <= 0 means the
// default, so an unset config cannot silently disable the sweep.
func (s *PushService) SetSubscriptionTTL(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d <= 0 {
		d = pushDefaultTTL
	}
	s.ttl = d
}

// SetContact installs push.contact, the mailto address carried as the VAPID JWT
// "sub". Empty omits the claim: an empty "mailto:" is not a valid contact and a
// push service may reject it.
func (s *PushService) SetContact(contact string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.contact = contact
}

// PublicKey returns the running key's public bytes (base64url, no padding, the
// 65-byte uncompressed point) and key id (hex of the first 8 bytes of
// SHA-256(public key)); ok is false until a key is installed.
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

// Subscribe validates in, upserts the row for userID under the running VAPID key
// id and trims to the device cap, evicting the oldest by last_seen_at.
// Re-subscribing the same endpoint refreshes last_seen_at instead of adding a row.
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

// List returns userID's subscriptions under the running VAPID key; a row written
// under a since-rotated key is invisible until the sweep removes it.
func (s *PushService) List(ctx context.Context, userID int64) ([]db.PushSubscription, error) {
	rows, err := s.st.ListPushSubscriptions(ctx, userID, s.currentKeyID())
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// Revoke deletes id, scoped to userID so one user cannot revoke another's by
// guessing; ErrNotFound when the id does not exist or is someone else's.
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

// Sweep deletes every subscription past the staleness window and, once a key is
// installed, every one whose vapid_key_id no longer matches (staleness and
// rotation in one pass). With no key it sweeps by time only.
func (s *PushService) Sweep(ctx context.Context) (int64, error) {
	cutoff := time.Now().Add(-s.currentTTL())
	n, err := s.st.SweepPushSubscriptions(ctx, cutoff, s.currentKeyID())
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return n, nil
}

// ErrPushNotConfigured is returned by vapidAuthorization before a VAPID key is
// installed; SetVAPIDKey runs at start-up, so in production this only fires just
// before that stage.
var ErrPushNotConfigured = errors.New("push: no VAPID key installed")

// vapidTokenTTL is the RFC 8292 JWT lifetime (12h); the RFC recommends well under
// 24h so a leaked token cannot be replayed indefinitely.
const vapidTokenTTL = 12 * time.Hour

// vapidClaims is the RFC 8292 JWT claim set. Sub is omitted (not an empty
// "mailto:") when push.contact is unset, which omitempty does.
type vapidClaims struct {
	Aud string `json:"aud"`
	Exp int64  `json:"exp"`
	Sub string `json:"sub,omitempty"`
}

// webOrigin serialises u's origin per RFC 6454: lowercase scheme and host, port
// omitted when default. "https://PUSH.EXAMPLE.NET:443/x" and
// "https://push.example.net/x" are one origin, and a push service comparing the
// VAPID "aud" byte-for-byte must see the same bytes.
func webOrigin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := normaliseOriginHost(u.Hostname())
	if port := normalisePort(u.Port()); port != "" && port != defaultPortFor(scheme) {
		host = host + ":" + port
	}
	return scheme + "://" + host
}

// normaliseOriginHost is webOrigin's host component:
//   - an IP literal is re-bracketed if v6: url.Hostname() strips the brackets and
//     "aud" needs them back or it parses as a hostname full of colons;
//   - anything else is folded to canonical ASCII (Punycode) with idna's Lookup
//     profile (RFC 5891), which also case-folds, so an uppercase Unicode label and
//     its lowercase spelling give one origin. A host idna refuses is
//     ASCII-lowercased.
func normaliseOriginHost(host string) string {
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Is6() {
			return "[" + ip.String() + "]"
		}
		return ip.String()
	}
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		return ascii
	}
	return strings.ToLower(host)
}

// normalisePort returns port's canonical decimal form ("0443" -> "443"), so a
// non-canonical default port is still recognised as default. A non-numeric port
// passes through unchanged.
func normalisePort(port string) string {
	n, err := strconv.Atoi(port)
	if err != nil {
		return port
	}
	return strconv.Itoa(n)
}

// defaultPortFor is the scheme's default port per RFC 6454, "" for any other
// scheme (never treated as default).
func defaultPortFor(scheme string) string {
	switch scheme {
	case "https":
		return "443"
	case "http":
		return "80"
	default:
		return ""
	}
}

// vapidAuthorization builds the RFC 8292 VAPID Authorization value for a push to
// endpoint: an ES256 JWT with header {"typ":"JWT","alg":"ES256"}, claims aud
// (scheme://host), exp (now+12h) and sub ("mailto:"+push.contact, omitted when
// empty), as "vapid t=<jwt>, k=<public key>". The private scalar never leaves this
// method. The signature is raw r||s (64 octets, RFC 7518 3.4), not ASN.1, as a
// push service validates it.
func (s *PushService) vapidAuthorization(endpoint string) (string, error) {
	s.mu.Lock()
	priv, pubB64, contact := s.priv, s.pubB64, s.contact
	s.mu.Unlock()
	if priv == nil {
		return "", ErrPushNotConfigured
	}

	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%w: endpoint has no origin", ErrInvalidSubscription)
	}

	claims := vapidClaims{Aud: webOrigin(u), Exp: time.Now().Add(vapidTokenTTL).Unix()}
	if contact != "" {
		claims.Sub = "mailto:" + contact
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("%w: encoding VAPID claims: %w", ErrInternal, err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) +
		"." + base64.RawURLEncoding.EncodeToString(claimsJSON)

	ecdsaPriv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), priv.Bytes())
	if err != nil {
		return "", fmt.Errorf("%w: converting VAPID key: %w", ErrInternal, err)
	}
	digest := sha256.Sum256([]byte(signingInput))
	r, sig, err := ecdsa.Sign(rand.Reader, ecdsaPriv, digest[:])
	if err != nil {
		return "", fmt.Errorf("%w: signing VAPID JWT: %w", ErrInternal, err)
	}
	rawSig := make([]byte, 64)
	r.FillBytes(rawSig[:32])
	sig.FillBytes(rawSig[32:])
	jwt := signingInput + "." + base64.RawURLEncoding.EncodeToString(rawSig)

	return fmt.Sprintf("vapid t=%s, k=%s", jwt, pubB64), nil
}

// validatePushSubscription checks in and returns the canonical (decoded and
// re-encoded raw-url-base64) credential forms the row stores.
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
	if _, err := ecdh.P256().NewPublicKey(p256dhBytes); err != nil {
		return "", "", "", fmt.Errorf("%w: p256dh is not a valid P-256 point", ErrInvalidSubscription)
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

// decodePushBase64 accepts padded and unpadded base64url by trimming "=" before
// the raw decode; browsers' PushSubscription.toJSON() and client libraries disagree.
func decodePushBase64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
