package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

type ownTokensBody struct {
	Tokens []struct {
		ID       int64   `json:"id"`
		Label    string  `json:"label"`
		LastUsed *string `json:"last_used"`
	} `json:"tokens"`
}

func listOwnTokens(t *testing.T, h http.Handler, sessionTok string) ownTokensBody {
	t.Helper()
	rr := bearerJSON(t, h, http.MethodGet, "/api/v1/users/me/api-tokens", sessionTok, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("list tokens: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var body ownTokensBody
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

func createPasswordUser(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	hash, err := auth.HashPassword(loginSessionTestPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(context.Background(), name, hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return uid
}

func tokenWorks(t *testing.T, database *db.DB, raw string) bool {
	t.Helper()
	tok, err := database.GetActiveAPIToken(context.Background(), auth.HashToken(raw))
	if err != nil {
		t.Fatalf("GetActiveAPIToken: %v", err)
	}
	return tok != nil
}

func TestOwnAPITokens_ListShowsOnlyTheCallersLiveTokens(t *testing.T) {
	router, database := fullRouterWithDB(t)
	ctx := context.Background()
	alice := createPasswordUser(t, database, "alice-tokens")
	bob := createPasswordUser(t, database, "bob-tokens")
	sessionTok := issueSessionToken(t, database, alice)

	issueAPIToken(t, database, alice)
	revokedID, err := database.CreateAPIToken(ctx, alice, auth.HashToken("gone"), "old-bot", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	if _, err := database.RevokeAPIToken(ctx, revokedID); err != nil {
		t.Fatalf("RevokeAPIToken: %v", err)
	}
	issueAPIToken(t, database, bob)

	body := listOwnTokens(t, router, sessionTok)
	if len(body.Tokens) != 1 || body.Tokens[0].Label != "bot" {
		t.Fatalf("tokens = %+v, want only alice's live \"bot\" token", body.Tokens)
	}
}

func TestOwnAPITokens_RevokeOwnTokenOnly(t *testing.T) {
	router, database := fullRouterWithDB(t)
	alice := createPasswordUser(t, database, "alice-revoke")
	bob := createPasswordUser(t, database, "bob-revoke")
	sessionTok := issueSessionToken(t, database, alice)
	aliceRaw := issueAPIToken(t, database, alice)
	bobRaw := issueAPIToken(t, database, bob)

	ids := listOwnTokens(t, router, issueSessionToken(t, database, bob))
	bobID := ids.Tokens[0].ID
	rr := bearerJSON(t, router, http.MethodDelete, fmt.Sprintf("/api/v1/users/me/api-tokens/%d", bobID), sessionTok, nil)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("revoking another account's token: status = %d, want 404; body = %s", rr.Code, rr.Body.String())
	}
	if !tokenWorks(t, database, bobRaw) {
		t.Fatal("another account's token was revoked")
	}

	aliceID := listOwnTokens(t, router, sessionTok).Tokens[0].ID
	path := fmt.Sprintf("/api/v1/users/me/api-tokens/%d", aliceID)
	if rr := bearerJSON(t, router, http.MethodDelete, path, sessionTok, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("revoke own token: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if tokenWorks(t, database, aliceRaw) {
		t.Fatal("revoked token still works")
	}
	// A second revoke of the same token is not a second success.
	if rr := bearerJSON(t, router, http.MethodDelete, path, sessionTok, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("repeat revoke: status = %d, want 404", rr.Code)
	}
	if n := len(listOwnTokens(t, router, sessionTok).Tokens); n != 0 {
		t.Fatalf("list after revoke has %d tokens, want 0", n)
	}
}

func TestChangePassword_RevokeAPITokensOption(t *testing.T) {
	cases := []struct {
		name       string
		body       map[string]any
		wantTokens bool
	}{
		{"field absent keeps tokens", map[string]any{}, true},
		{"false keeps tokens", map[string]any{"revoke_api_tokens": false}, true},
		{"true revokes tokens", map[string]any{"revoke_api_tokens": true}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router, database := fullRouterWithDB(t)
			uid := createPasswordUser(t, database, "pw-tokens")
			otherUID := createPasswordUser(t, database, "pw-bystander")
			sessionTok := issueSessionToken(t, database, uid)
			raw := issueAPIToken(t, database, uid)
			otherRaw := issueAPIToken(t, database, otherUID)

			body := map[string]any{"old_password": loginSessionTestPassword, "new_password": "Another-Pass2!"}
			for k, v := range tc.body {
				body[k] = v
			}
			rr := bearerJSON(t, router, http.MethodPut, "/api/v1/users/me/password", sessionTok, body)
			if rr.Code != http.StatusNoContent {
				t.Fatalf("change password: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
			}
			if got := tokenWorks(t, database, raw); got != tc.wantTokens {
				t.Fatalf("token still works = %v, want %v", got, tc.wantTokens)
			}
			if !tokenWorks(t, database, otherRaw) {
				t.Fatal("another account's token was revoked by a password change")
			}
		})
	}
}
