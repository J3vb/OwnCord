package auth

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestRecoveryKitSecret_ShapeAndNormalization(t *testing.T) {
	shown, canonical, err := GenerateRecoveryKitSecret()
	if err != nil {
		t.Fatalf("GenerateRecoveryKitSecret: %v", err)
	}
	if groups := strings.Split(shown, "-"); len(groups) != 8 || len(shown) != 39 {
		t.Fatalf("shown = %q, want eight groups of four", shown)
	}
	if got, ok := NormalizeRecoveryKitSecret(shown); !ok || got != canonical {
		t.Fatalf("Normalize(shown) = %q, %v; want %q", got, ok, canonical)
	}
	spaced := strings.ToLower(strings.ReplaceAll(shown, "-", " "))
	if got, ok := NormalizeRecoveryKitSecret(" " + spaced + "\n"); !ok || got != canonical {
		t.Fatalf("Normalize(lower, spaced) = %q, %v; want %q", got, ok, canonical)
	}
	for _, bad := range []string{"", canonical[:31], canonical + "A", "1" + canonical[1:], "not a kit"} {
		if _, ok := NormalizeRecoveryKitSecret(bad); ok {
			t.Errorf("Normalize(%q) accepted a malformed secret", bad)
		}
	}
	other, _, _ := GenerateRecoveryKitSecret()
	if other == shown {
		t.Fatal("two generated secrets are equal")
	}
}

func TestRecoveryKitVerifier_RoundTrip(t *testing.T) {
	_, canonical, _ := GenerateRecoveryKitSecret()
	verifier, err := HashRecoveryKitSecret(canonical)
	if err != nil {
		t.Fatalf("HashRecoveryKitSecret: %v", err)
	}
	if !strings.HasPrefix(verifier, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("verifier = %q, want the argon2id PHC prefix", verifier)
	}
	if strings.Contains(verifier, canonical) {
		t.Fatal("the verifier contains the secret")
	}
	if !VerifyRecoveryKitSecret(verifier, canonical) {
		t.Fatal("the right secret does not verify")
	}
	_, wrong, _ := GenerateRecoveryKitSecret()
	if VerifyRecoveryKitSecret(verifier, wrong) {
		t.Fatal("a wrong secret verifies")
	}
	again, _ := HashRecoveryKitSecret(canonical)
	if again == verifier {
		t.Fatal("two verifiers of one secret are equal: the salt is not random")
	}
}

func TestRecoveryKitVerifier_ParametersComeFromTheVerifier(t *testing.T) {
	_, canonical, _ := GenerateRecoveryKitSecret()
	salt := []byte("sixteen-byte-salt")[:16]
	key := argon2.IDKey([]byte(canonical), salt, 1, 8*1024, 2, 32)
	legacy := fmt.Sprintf("$argon2id$v=19$m=8192,t=1,p=2$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
	if !VerifyRecoveryKitSecret(legacy, canonical) {
		t.Fatal("a verifier made under other parameters does not verify")
	}
	for _, bad := range []string{"", "$argon2id$v=19$m=8192,t=1,p=2$salt", "$bcrypt$x", "$argon2id$v=18$m=8192,t=1,p=2$AAAA$AAAA", "$argon2id$v=19$m=0,t=1,p=1$AAAA$AAAA"} {
		if VerifyRecoveryKitSecret(bad, canonical) {
			t.Errorf("malformed verifier %q verified", bad)
		}
	}
	if _, err := DummyRecoveryKitVerifier(); err != nil {
		t.Fatalf("DummyRecoveryKitVerifier: %v", err)
	}
}

// An owner-issued credential (B4-6) is shorter than a kit secret, and the
// shape alone tells the two apart.
func TestRecoveryAssistSecret_ShapeAndKind(t *testing.T) {
	shown, canonical, err := GenerateRecoveryAssistSecret()
	if err != nil {
		t.Fatalf("GenerateRecoveryAssistSecret: %v", err)
	}
	if groups := strings.Split(shown, "-"); len(groups) != 6 || len(shown) != 29 || len(canonical) != 24 {
		t.Fatalf("shown = %q (canonical %d chars), want six groups of four", shown, len(canonical))
	}
	if got, kind := NormalizeRecoverySecret(strings.ToLower(shown)); kind != RecoverySecretAssist || got != canonical {
		t.Fatalf("NormalizeRecoverySecret(credential) = %q, %v; want %q as an assist secret", got, kind, canonical)
	}
	kitShown, kitCanonical, _ := GenerateRecoveryKitSecret()
	if got, kind := NormalizeRecoverySecret(kitShown); kind != RecoverySecretKit || got != kitCanonical {
		t.Fatalf("NormalizeRecoverySecret(kit) = %q, %v; want the kit shape", got, kind)
	}
	for _, bad := range []string{"", canonical[:23], canonical + "A", "1" + canonical[1:], kitCanonical[:30]} {
		if _, kind := NormalizeRecoverySecret(bad); kind != RecoverySecretMalformed {
			t.Errorf("NormalizeRecoverySecret(%q) = %v, want malformed", bad, kind)
		}
	}
	// A credential verifies like a kit secret: same argon2id verifier shape.
	verifier, err := HashRecoveryKitSecret(canonical)
	if err != nil {
		t.Fatalf("HashRecoveryKitSecret: %v", err)
	}
	if !VerifyRecoveryKitSecret(verifier, canonical) || VerifyRecoveryKitSecret(verifier, kitCanonical) {
		t.Fatal("the credential's verifier accepts the wrong secret or refuses the right one")
	}
}

// A verifier from another version or with absent parameters never verifies.
func TestRecoveryKitVerifier_RefusesForeignParameters(t *testing.T) {
	_, canonical, _ := GenerateRecoveryKitSecret()
	verifier, err := HashRecoveryKitSecret(canonical)
	if err != nil {
		t.Fatalf("HashRecoveryKitSecret: %v", err)
	}
	parts := strings.Split(verifier, "$")
	if len(parts) != 6 {
		t.Fatalf("verifier has %d fields, want 6: %q", len(parts), verifier)
	}
	foreign := func(version, params string) string {
		p := append([]string(nil), parts...)
		p[2], p[3] = version, params
		return strings.Join(p, "$")
	}
	for name, v := range map[string]string{
		"other version":  foreign("v=18", parts[3]),
		"zero memory":    foreign(parts[2], "m=0,t=2,p=1"),
		"zero time":      foreign(parts[2], "m=19456,t=0,p=1"),
		"zero threads":   foreign(parts[2], "m=19456,t=2,p=0"),
		"garbled params": foreign(parts[2], "memory=19456"),
		"bad salt":       strings.Join(append(append([]string(nil), parts[:4]...), "*not-base64*", parts[5]), "$"),
		"bad hash":       strings.Join(append(append([]string(nil), parts[:5]...), "*not-base64*"), "$"),
	} {
		if VerifyRecoveryKitSecret(v, canonical) {
			t.Errorf("%s: verifier %q accepted the secret", name, v)
		}
	}
}
