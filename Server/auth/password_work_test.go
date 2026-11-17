package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// Every refusal runs one bcrypt and one argon2id computation, whatever the
// account holds, so the work a wrong password costs never depends on its state.
func TestVerifyPassword_FailuresDoTheSameWork(t *testing.T) {
	legacy, err := bcrypt.GenerateFromPassword([]byte("right-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	current, err := HashPassword("right-password")
	if err != nil {
		t.Fatal(err)
	}
	initDummyHashes()
	counts := map[string]int{}
	hashWorkHook = func(scheme string) { counts[scheme]++ }
	t.Cleanup(func() { hashWorkHook = nil })

	cases := []struct {
		name, hash, password string
		wantMatch            bool
		want                 map[string]int
	}{
		{"unknown user", "", "wrong-password", false, map[string]int{"bcrypt": 1, "argon2id": 1}},
		{"bcrypt mismatch", string(legacy), "wrong-password", false, map[string]int{"bcrypt": 1, "argon2id": 1}},
		{"argon2id mismatch", current, "wrong-password", false, map[string]int{"bcrypt": 1, "argon2id": 1}},
		{"bcrypt match", string(legacy), "right-password", true, map[string]int{"bcrypt": 1}},
		{"argon2id match", current, "right-password", true, map[string]int{"argon2id": 1}},
	}
	for _, tc := range cases {
		clear(counts)
		if matched, _ := VerifyPassword(tc.hash, tc.password); matched != tc.wantMatch {
			t.Fatalf("%s: matched = %v, want %v", tc.name, matched, tc.wantMatch)
		}
		if len(counts) != len(tc.want) || counts["bcrypt"] != tc.want["bcrypt"] || counts["argon2id"] != tc.want["argon2id"] {
			t.Errorf("%s: hash work = %v, want %v", tc.name, counts, tc.want)
		}
	}
}
