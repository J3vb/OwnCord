package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// WP 3C-9: the strict username rules apply to a name being chosen (register,
// rename) and never to one already held (login, recovery).

func registerWithInvite(t *testing.T, router http.Handler, ownerID int64, database *db.DB, username string) int {
	t.Helper()
	code, err := database.CreateInvite(context.Background(), ownerID, 1, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    username,
		"password":    "securePass1",
		"invite_code": code,
	})
	return rr.Code
}

func TestRegister_RefusesStrictInvalidUsername(t *testing.T) {
	database := newAuthTestDB(t)
	ownerID := seedUser(t, database, "owner_x", "securePass1", 1)

	for _, name := range []string{"has space", "emoji😀name", "_lead", "everyone", "EVERYONE", "Here"} {
		// A fresh limiter per attempt: register allows three tries per window.
		router := buildAuthRouter(database, auth.NewRateLimiter())
		if code := registerWithInvite(t, router, ownerID, database, name); code != http.StatusBadRequest {
			t.Errorf("register %q = %d, want 400", name, code)
		}
	}
}

// Edge case 2: a precomposed and a decomposed accent both pass.
func TestRegister_AcceptsNFCAndNFDAccents(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	ownerID := seedUser(t, database, "owner_y", "securePass1", 1)

	for _, name := range []string{"caf\u00e9a", "cafe\u0301b"} {
		if code := registerWithInvite(t, router, ownerID, database, name); code != http.StatusOK && code != http.StatusCreated {
			t.Errorf("register %q = %d, want success", name, code)
		}
	}
}

func TestUpdateProfile_RenameRefusesStrictInvalidUsername(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "renamer", 4)

	for _, name := range []string{"has space", "emoji😀name", "_lead", "Everyone", "here"} {
		rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": name})
		if rr.Code != http.StatusBadRequest {
			t.Errorf("rename to %q = %d, want 400; body = %s", name, rr.Code, rr.Body.String())
		}
	}
	for _, name := range []string{"caf\u00e9c", "cafe\u0301d"} {
		rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": name})
		if rr.Code != http.StatusOK {
			t.Errorf("rename to %q = %d, want 200; body = %s", name, rr.Code, rr.Body.String())
		}
	}
}

// Edge case 1: an account whose stored name breaks the strict rules (inserted
// directly, as every account made before 3C-9 is) still logs in and recovers,
// can still edit the rest of its profile, and is refused only a rename.
func TestLegacyUsername_StillLogsInRecoversAndEditsProfile(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)
	profileRouter := buildProfileRouter(database)
	const legacy = "old name"
	uid := seedUser(t, database, legacy, "LegacyPass1!", 4)
	token := issueSessionToken(t, database, uid)

	if rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{"username": legacy, "password": "LegacyPass1!"}); rr.Code != http.StatusOK {
		t.Fatalf("login with a legacy name = %d; body = %s", rr.Code, rr.Body.String())
	}

	rr := postJSONWithToken(t, router, "/api/v1/users/me/recovery-kit", token, map[string]string{"password": "LegacyPass1!"})
	if rr.Code != http.StatusOK {
		t.Fatalf("enrolment = %d; body = %s", rr.Code, rr.Body.String())
	}
	var issue struct {
		KitSecret string `json:"kit_secret"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&issue)
	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": legacy, "kit_secret": issue.KitSecret, "new_password": "Recovered-Pass2!"})
	if rr.Code != http.StatusOK {
		t.Fatalf("recovery with a legacy name = %d; body = %s", rr.Code, rr.Body.String())
	}

	// Recovery revoked every session; sign in again for the profile calls.
	token = issueSessionToken(t, database, uid)

	// Resending the same name while editing another field is not a rename.
	rr = patchJSON(t, profileRouter, "/api/v1/users/me", token, map[string]string{"username": legacy, "display_name": "Old Name"})
	if rr.Code != http.StatusOK {
		t.Fatalf("display-name edit that resends the legacy name = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	// Only an actual rename is held to the strict rules.
	rr = patchJSON(t, profileRouter, "/api/v1/users/me", token, map[string]string{"username": "another name"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("rename to a name with a space = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpdateProfile_DisplayNameCharacterRules(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "dnrules", 4)

	// Cases the pre-3C-9 control/Cf check let through (separators, blank
	// fillers, mark stacks, entity-encoded separators) plus the old ones.
	for _, name := range []string{"two\nlines", "tab\there", "e\u0301\u0302\u0303", "a\u200bb", "a\u2028b", "a&#x2028;b", "a\u3164b", "a\u034fb"} {
		rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "dnrules", "display_name": name})
		if rr.Code != http.StatusBadRequest {
			t.Errorf("display_name %q = %d, want 400; body = %s", name, rr.Code, rr.Body.String())
			continue
		}
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(rr.Body).Decode(&e)
		if e.Error != "INVALID_INPUT" {
			t.Errorf("display_name %q error code = %q, want INVALID_INPUT", name, e.Error)
		}
	}
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "dnrules", "display_name": "  Ada    Lovelace  "})
	if rr.Code != http.StatusOK {
		t.Fatalf("display_name with extra spaces = %d; body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		DisplayName string `json:"display_name"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got.DisplayName != "Ada Lovelace" {
		t.Errorf("display_name = %q, want collapsed %q", got.DisplayName, "Ada Lovelace")
	}
}

// A legacy name with an apostrophe (made before the strict rules) keeps
// working: it can be resent while editing the display name, and recovery
// accepts it.
func TestLegacyApostropheUsername_ProfileEditAndRecovery(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	profileRouter := buildProfileRouter(database)
	const legacy = "O'Brien"
	uid := seedUser(t, database, legacy, "LegacyPass1!", 4)
	token := issueSessionToken(t, database, uid)

	rr := patchJSON(t, profileRouter, "/api/v1/users/me", token, map[string]string{"username": legacy, "display_name": "Paddy"})
	if rr.Code != http.StatusOK {
		t.Fatalf("PATCH with the legacy name and a new display name = %d; body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&got)
	if got.Username != legacy || got.DisplayName != "Paddy" {
		t.Errorf("response username=%q display_name=%q, want %q / %q", got.Username, got.DisplayName, legacy, "Paddy")
	}

	rr = postJSONWithToken(t, router, "/api/v1/users/me/recovery-kit", token, map[string]string{"password": "LegacyPass1!"})
	if rr.Code != http.StatusOK {
		t.Fatalf("enrolment = %d; body = %s", rr.Code, rr.Body.String())
	}
	var issue struct {
		KitSecret string `json:"kit_secret"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&issue)
	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": legacy, "kit_secret": issue.KitSecret, "new_password": "Recovered-Pass2!"})
	if rr.Code != http.StatusOK {
		t.Fatalf("recovery with a legacy apostrophe name = %d; body = %s", rr.Code, rr.Body.String())
	}
}
