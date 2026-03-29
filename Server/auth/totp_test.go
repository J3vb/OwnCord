package auth_test

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

func TestGenerateTOTPCodeAndVerify_RFCVector(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	code, err := auth.GenerateTOTPCode(secret, time.Unix(59, 0).UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	if code != "287082" {
		t.Fatalf("code = %q, want 287082", code)
	}
	if !auth.VerifyTOTPCode(secret, code, time.Unix(59, 0).UTC()) {
		t.Fatal("VerifyTOTPCode should accept the RFC vector code")
	}
	if auth.VerifyTOTPCode(secret, "000000", time.Unix(59, 0).UTC()) {
		t.Fatal("VerifyTOTPCode should reject an invalid code")
	}
}

func TestBuildTOTPURI_ContainsIssuerAndSecret(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	uri := auth.BuildTOTPURI("alice", secret, "OwnCord")
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("url.Parse: %v", err)
	}
	if parsed.Scheme != "otpauth" {
		t.Fatalf("scheme = %q, want otpauth", parsed.Scheme)
	}
	if !strings.Contains(parsed.Path, "OwnCord:alice") {
		t.Fatalf("path = %q, want issuer and username label", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("secret") != secret {
		t.Fatalf("secret = %q, want %q", query.Get("secret"), secret)
	}
	if query.Get("issuer") != "OwnCord" {
		t.Fatalf("issuer = %q, want OwnCord", query.Get("issuer"))
	}
}
