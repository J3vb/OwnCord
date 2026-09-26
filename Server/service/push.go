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

	mu      syncutil.Mutex
	priv    *ecdh.PrivateKey
	pubB64  string
	keyID   string
	ttl     time.Duration
	contact string
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

// SetContact installs push.contact (B5-11), the mailto address VAPID JWTs
// carry as their "sub" claim. Empty (the default) means the claim is
// omitted entirely, not sent as "mailto:" — an empty sub is not a valid
// contact and a push service is entitled to reject it.
func (s *PushService) SetContact(contact string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.contact = contact
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

// ErrPushNotConfigured is returned by vapidAuthorization before any VAPID
// key has been installed — SetVAPIDKey runs unconditionally at start-up
// (B5-4), so in production this only fires in the instant before that stage
// runs.
var ErrPushNotConfigured = errors.New("push: no VAPID key installed")

// vapidTokenTTL is the RFC 8292 JWT lifetime (plan decision 9: 12h). RFC
// 8292 recommends staying well under 24h so a leaked token cannot be
// replayed indefinitely.
const vapidTokenTTL = 12 * time.Hour

// vapidClaims is the RFC 8292 JWT claim set. Sub is omitted (not sent as an
// empty "mailto:") when push.contact is unset — encoding/json's omitempty
// on a string drops it precisely then.
type vapidClaims struct {
	Aud string `json:"aud"`
	Exp int64  `json:"exp"`
	Sub string `json:"sub,omitempty"`
}

// webOrigin serialises u's origin per RFC 6454 SS4: lowercase scheme,
// lowercase host, and the port omitted when it is the scheme's default —
// "https://PUSH.EXAMPLE.NET:443/x" and "https://push.example.net/x" name
// the same origin, and a push service comparing the VAPID "aud" claim
// byte-for-byte against its own origin string must see the same bytes
// either way.
func webOrigin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := normaliseOriginHost(u.Hostname())
	if port := normalisePort(u.Port()); port != "" && port != defaultPortFor(scheme) {
		host = host + ":" + port
	}
	return scheme + "://" + host
}

// normaliseOriginHost is the host component of webOrigin's result:
//   - an IP literal (v4 or v6) is re-bracketed if it is v6 -- url.Hostname()
//     strips the brackets a URI writes an IPv6 host with, and "aud" needs
//     them back or the value parses as a hostname full of colons;
//   - anything else is folded to its canonical ASCII (Punycode) form with
//     golang.org/x/net/idna's Lookup profile (RFC 5891 SS5), which also
//     case-folds -- an uppercase Unicode label and its lowercase spelling
//     must produce the same origin string. idna is already in go.mod
//     (pulled in transitively); this is the first direct import of it.
//     A host idna refuses is lowercased instead, ASCII-only, same as
//     before this fix.
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

// normalisePort returns port's canonical decimal form ("0443" -> "443"),
// so a numerically-default port in a non-canonical spelling is still
// recognised as default by webOrigin. A non-numeric port (never valid in a
// URL, but url.URL does not itself refuse one) passes through unchanged.
func normalisePort(port string) string {
	n, err := strconv.Atoi(port)
	if err != nil {
		return port
	}
	return strconv.Itoa(n)
}

// defaultPortFor is the scheme's default port per RFC 6454; "" for any
// other scheme, which webOrigin then never treats as default.
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

// vapidAuthorization builds the RFC 8292 VAPID Authorization header value
// for a push to endpoint: an ES256-signed JWT with header
// {"typ":"JWT","alg":"ES256"}, claims aud (the endpoint's scheme://host),
// exp (now+12h) and sub ("mailto:"+push.contact, omitted when empty), and
// the header value "vapid t=<jwt>, k=<public key>". The private scalar
// never leaves this method — every caller gets a finished header value, not
// a key or a raw signature.
//
// The signature is raw r||s (64 octets, RFC 8292's JWS encoding), not
// ASN.1: a JOSE ES256 signature is defined that way (RFC 7518 SS3.4), and a
// push service validates it as such.
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
