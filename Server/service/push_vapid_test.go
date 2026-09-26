package service

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestPushVAPID_JWTVerifiesAndClaims builds a real VAPID key, signs a header
// for a real endpoint, and verifies the result the way a push service would:
// splitting the JWS, reconstructing the raw r||s signature, verifying it
// against the installed public key with crypto/ecdsa, and checking every
// claim (RFC 8292).
func TestPushVAPID_JWTVerifiesAndClaims(t *testing.T) {
	svc := NewPushService(nil)
	priv := genTestVAPIDKey(t)
	svc.SetVAPIDKey(priv)
	svc.SetContact("ops@example.invalid")

	before := time.Now()
	header, err := svc.vapidAuthorization("https://push.example.net/subscribe/abc123?x=1")
	if err != nil {
		t.Fatalf("vapidAuthorization: %v", err)
	}

	// "vapid t=<jwt>, k=<pubkey>"
	if !strings.HasPrefix(header, "vapid t=") {
		t.Fatalf("header = %q, want a leading %q", header, "vapid t=")
	}
	rest := strings.TrimPrefix(header, "vapid t=")
	jwtPart, kPart, ok := strings.Cut(rest, ", k=")
	if !ok {
		t.Fatalf("header = %q, want %q separating the token and the key", header, ", k=")
	}
	wantPub, _, _ := svc.PublicKey()
	if kPart != wantPub {
		t.Errorf("k = %q, want the running public key %q", kPart, wantPub)
	}

	parts := strings.Split(jwtPart, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt has %d segments, want 3", len(parts))
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decoding JWT header: %v", err)
	}
	var hdr struct {
		Typ string `json:"typ"`
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		t.Fatalf("unmarshalling JWT header: %v", err)
	}
	if hdr.Typ != "JWT" || hdr.Alg != "ES256" {
		t.Errorf("JWT header = %+v, want typ=JWT alg=ES256", hdr)
	}

	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decoding claims: %v", err)
	}
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatalf("unmarshalling claims: %v", err)
	}
	if claims.Aud != "https://push.example.net" {
		t.Errorf("aud = %q, want the endpoint's origin %q", claims.Aud, "https://push.example.net")
	}
	if claims.Sub != "mailto:ops@example.invalid" {
		t.Errorf("sub = %q, want %q", claims.Sub, "mailto:ops@example.invalid")
	}
	wantExp := before.Add(vapidTokenTTL)
	gotExp := time.Unix(claims.Exp, 0)
	if d := gotExp.Sub(wantExp); d < -5*time.Second || d > 5*time.Second {
		t.Errorf("exp = %v, want ~%v (now+12h)", gotExp, wantExp)
	}

	sigRaw, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decoding signature: %v", err)
	}
	if len(sigRaw) != 64 {
		t.Fatalf("signature is %d bytes, want 64 (raw r||s)", len(sigRaw))
	}
	r := new(big.Int).SetBytes(sigRaw[:32])
	s := new(big.Int).SetBytes(sigRaw[32:])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	// Reconstruct the ecdsa public key from the same raw point PublicKey()
	// reports, rather than re-deriving it from priv, so the test also
	// proves the reported public key is the one that actually signed.
	pubPoint, err := base64.RawURLEncoding.DecodeString(wantPub)
	if err != nil || len(pubPoint) != 65 || pubPoint[0] != 0x04 {
		t.Fatalf("PublicKey() returned an unexpected point: %x (err %v)", pubPoint, err)
	}
	x := new(big.Int).SetBytes(pubPoint[1:33])
	y := new(big.Int).SetBytes(pubPoint[33:65])
	verifyKey := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}
	if !ecdsa.Verify(verifyKey, digest[:], r, s) {
		t.Error("ecdsa.Verify failed against the reported public key")
	}
}

// TestPushVAPID_NoKeyIsNotConfigured proves the fail-closed path: no push
// happens under a key that was never installed.
func TestPushVAPID_NoKeyIsNotConfigured(t *testing.T) {
	svc := NewPushService(nil)
	if _, err := svc.vapidAuthorization("https://push.example.net/x"); err == nil {
		t.Fatal("vapidAuthorization succeeded with no VAPID key installed")
	}
}

// TestPushVAPID_EmptyContactOmitsSub proves push.contact's documented
// default: empty means the sub claim is absent, not "mailto:".
func TestPushVAPID_EmptyContactOmitsSub(t *testing.T) {
	svc := NewPushService(nil)
	svc.SetVAPIDKey(genTestVAPIDKey(t))

	header, err := svc.vapidAuthorization("https://push.example.net/x")
	if err != nil {
		t.Fatalf("vapidAuthorization: %v", err)
	}
	jwtPart, _, _ := strings.Cut(strings.TrimPrefix(header, "vapid t="), ", k=")
	parts := strings.Split(jwtPart, ".")
	claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if strings.Contains(string(claimsJSON), "sub") {
		t.Errorf("claims = %s, want no sub claim with an empty contact", claimsJSON)
	}
}

// TestPushVAPID_AudIsRFC6454Origin proves the "aud" claim is a normalised
// origin, not a copy of the endpoint's host: uppercase folds to lowercase
// and an explicit default port (443 for https) is dropped, so a push
// service comparing "aud" byte-for-byte against its own origin string
// matches regardless of how the endpoint happened to be written.
func TestPushVAPID_AudIsRFC6454Origin(t *testing.T) {
	svc := NewPushService(nil)
	svc.SetVAPIDKey(genTestVAPIDKey(t))

	header, err := svc.vapidAuthorization("https://PUSH.EXAMPLE.NET:443/x")
	if err != nil {
		t.Fatalf("vapidAuthorization: %v", err)
	}
	jwtPart, _, _ := strings.Cut(strings.TrimPrefix(header, "vapid t="), ", k=")
	parts := strings.Split(jwtPart, ".")
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decoding claims: %v", err)
	}
	var claims struct {
		Aud string `json:"aud"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatalf("unmarshalling claims: %v", err)
	}
	if claims.Aud != "https://push.example.net" {
		t.Errorf("aud = %q, want %q", claims.Aud, "https://push.example.net")
	}
}

// TestWebOrigin_TableCases pins the RFC 6454 edge cases a bare
// scheme+"://"+Host copy gets wrong: an IPv6 literal needs its brackets
// back (url.Hostname() strips them), an uppercase IDN label must fold to
// the same Punycode as its lowercase spelling, and a default port survives
// re-parsing regardless of how it was spelled (a leading zero is still the
// same port number).
func TestWebOrigin_TableCases(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"IPv6 literal, brackets restored", "https://[2001:db8::1]/x", "https://[2001:db8::1]"},
		{"IPv6 literal with an explicit default port", "https://[2001:db8::1]:443/x", "https://[2001:db8::1]"},
		{"uppercase IDN folds to the same Punycode as lowercase", "https://MÜLLER.DE/x", "https://xn--mller-kva.de"},
		{"non-canonical default port spelling", "https://push.example.net:0443/x", "https://push.example.net"},
		{"http's own default port", "http://x:80/x", "http://x"},
		{"a non-default port survives", "https://push.example.net:8443/x", "https://push.example.net:8443"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, err := url.Parse(c.in)
			if err != nil {
				t.Fatalf("url.Parse(%q): %v", c.in, err)
			}
			if got := webOrigin(u); got != c.want {
				t.Errorf("webOrigin(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
