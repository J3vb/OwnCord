package admin_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
)

// ─── API tokens: /admin/api/tokens ───────────────────────────────────────────

func TestAdminAPI_CreateAPIToken_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database) // Owner role

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "ci-bot"})
	requireStatus(t, w, http.StatusCreated)

	resp := decodeBody[map[string]any](t, w)
	raw, _ := resp["token"].(string)
	if raw == "" {
		t.Fatal("response missing raw token")
	}
	// The minted token must actually authenticate as the owner it was bound to.
	user, _, _, err := auth.ResolveTokenHash(context.Background(), database, auth.HashToken(raw))
	if err != nil || user == nil {
		t.Fatalf("minted token does not resolve: user=%v err=%v", user, err)
	}
	// And it must be listed, without any hash leaking.
	tokens, _ := database.ListAPITokens(context.Background())
	if len(tokens) != 1 || tokens[0].Label != "ci-bot" {
		t.Fatalf("expected 1 token labelled ci-bot, got %+v", tokens)
	}
}

func TestAdminAPI_CreateAPIToken_MissingLabel(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "  "})
	expectStatus(t, w, http.StatusBadRequest)
}

// TestAdminAPI_CreateAPIToken_NegativeExpiresHours pins OC-0145: a caller that
// asks for a bounded credential (negative expires_hours) must not silently
// receive a permanent one. The `> 0` check in handleCreateAPIToken sends any
// negative value down the nil-expiresAt ("never expires") branch.
func TestAdminAPI_CreateAPIToken_NegativeExpiresHours(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "neg-hours", "expires_hours": -1})
	requireStatus(t, w, http.StatusBadRequest)

	tokens, _ := database.ListAPITokens(context.Background())
	for _, tok := range tokens {
		if tok.Label == "neg-hours" {
			t.Fatalf("negative expires_hours must not mint a token, got %+v", tok)
		}
	}
}

// TestAdminAPI_CreateAPIToken_HugeExpiresHours pins OC-0145's overflow half: a
// huge expires_hours must not silently overflow time.Duration into a past
// timestamp and hand back a token that 401s on first use.
func TestAdminAPI_CreateAPIToken_HugeExpiresHours(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "huge-hours", "expires_hours": 3000000})
	requireStatus(t, w, http.StatusBadRequest)

	tokens, _ := database.ListAPITokens(context.Background())
	for _, tok := range tokens {
		if tok.Label == "huge-hours" {
			t.Fatalf("out-of-range expires_hours must not mint a token, got %+v", tok)
		}
	}
}

func TestAdminAPI_ListAPITokens_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	hash := auth.HashToken("raw-secret-value")
	if _, err := database.CreateAPIToken(context.Background(), 1, hash, "seeded", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/tokens", token, nil)
	requireStatus(t, w, http.StatusOK)
	if strings.Contains(w.Body.String(), hash) {
		t.Error("GET /tokens leaked the token hash")
	}
	tokens := decodeBody[[]map[string]any](t, w)
	if len(tokens) != 1 {
		t.Fatalf("expected 1 token, got %d", len(tokens))
	}
	if _, ok := tokens[0]["created_at"]; !ok {
		t.Error("token row missing snake_case 'created_at' field")
	}
}

func TestAdminAPI_RevokeAPIToken_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	hash := auth.HashToken("revoke-me")
	id, err := database.CreateAPIToken(context.Background(), 1, hash, "doomed", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete, "/tokens/"+itoa(id), token, nil)
	requireStatus(t, w, http.StatusNoContent)
	// A revoked token must no longer authenticate.
	active, _ := database.GetActiveAPIToken(context.Background(), hash)
	if active != nil {
		t.Error("token still active after revoke")
	}
}

func TestAdminAPI_RevokeAPIToken_NotFound(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodDelete, "/tokens/99999", token, nil)
	expectStatus(t, w, http.StatusNotFound)
}

// TestAdminAPI_Tokens_RequiresOwner locks the Owner gate: a non-Owner admin can
// authenticate to /admin/api but must not mint API tokens (the credential that
// survives password change + bulk logout).
func TestAdminAPI_Tokens_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	adminUID := mustCreateUser(t, database, "adminonly", "hash", 2)
	token := "admin-only-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "nope"})
	expectStatus(t, w, http.StatusForbidden)
}

func TestAdminAPI_Tokens_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/tokens", "", nil)
	expectStatus(t, w, http.StatusUnauthorized)
}
