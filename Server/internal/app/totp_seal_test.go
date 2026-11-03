package app

import (
	"slices"
	"testing"
)

// TestStages_TOTPSecretsFollowTheKeyAndMigrations pins that the conversion runs
// after the migrations and the key load, and before anything can serve.
func TestStages_TOTPSecretsFollowTheKeyAndMigrations(t *testing.T) {
	stages := (&App{}).stages()
	names := make([]string, 0, len(stages))
	for _, s := range stages {
		names = append(names, s.name)
	}
	at := slices.Index(names, "totp-secrets")
	if at < 0 {
		t.Fatal("no totp-secrets stage")
	}
	for _, before := range []string{"migrate", "totp-key"} {
		if i := slices.Index(names, before); i < 0 || i > at {
			t.Errorf("%s must start before totp-secrets: %v", before, names)
		}
	}
	for _, after := range []string{"hub", "router", "http"} {
		if i := slices.Index(names, after); i < at {
			t.Errorf("%s must start after totp-secrets: %v", after, names)
		}
	}
}
