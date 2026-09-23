package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// RI-06: GET .../access/explain and POST .../access/preview are read-only
// MANAGE_CHANNELS routes over the canonical predicates.

func TestAccessExplainAndPreview_Routes(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, newTestServices(database))
	token := createAdminUser(t, database)
	target := seedOverrideTarget(t, database, "explained")
	ctx := context.Background()
	chID, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	base := "/channels/" + itoa(chID) + "/access/"

	w := doRequest(t, handler, http.MethodGet, base+"explain?user_id="+itoa(target)+"&action=send_message", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("explain status = %d; body = %s", w.Code, w.Body.String())
	}
	var ex service.AccessExplanation
	if err := json.Unmarshal(w.Body.Bytes(), &ex); err != nil {
		t.Fatal(err)
	}
	if ex.UserID != target || len(ex.Decisions) != 1 || !ex.Decisions[0].Allowed {
		t.Fatalf("explain = %+v", ex)
	}

	for _, c := range []struct {
		query string
		want  int
	}{
		{"", http.StatusBadRequest},
		{"?user_id=abc", http.StatusBadRequest},
		{"?user_id=" + itoa(target), http.StatusBadRequest},
		{"?user_id=" + itoa(target) + "&action=fly", http.StatusBadRequest},
		{"?user_id=999999&action=view_channel", http.StatusNotFound},
	} {
		if w := doRequest(t, handler, http.MethodGet, base+"explain"+c.query, token, nil); w.Code != c.want {
			t.Errorf("explain%s = %d, want %d", c.query, w.Code, c.want)
		}
	}

	w = doRequest(t, handler, http.MethodPost, base+"preview", token,
		map[string]any{"role_id": 3, "deny": permissions.ReadMessages})
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d; body = %s", w.Code, w.Body.String())
	}
	var pv service.AccessPreview
	if err := json.Unmarshal(w.Body.Bytes(), &pv); err != nil {
		t.Fatal(err)
	}
	if pv.Evaluated != 1 || len(pv.Members) != 1 || pv.Members[0].UserID != target {
		t.Fatalf("preview = %+v, want the one role-3 member changed", pv)
	}
	if allow, deny, _ := database.GetChannelPermissions(ctx, chID, 3); allow != 0 || deny != 0 {
		t.Fatalf("preview wrote an override (%#x,%#x)", allow, deny)
	}
	if w := doRequest(t, handler, http.MethodPost, base+"preview", token, map[string]any{}); w.Code != http.StatusBadRequest {
		t.Errorf("preview without a target = %d, want 400", w.Code)
	}
	if w := doRequest(t, handler, http.MethodGet, "/channels/999999/access/explain?user_id="+itoa(target)+"&action=view_channel", token, nil); w.Code != http.StatusNotFound {
		t.Errorf("unknown channel = %d, want 404", w.Code)
	}
}

func TestAccessExplainAndPreview_RequireManageChannels(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// VIEW_AUDIT_LOG passes the admin perimeter but not MANAGE_CHANNELS.
	uid, token := createRoleUser(t, database, 11, "Auditor", permissions.ViewAuditLog, 50, "auditor")
	chID, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	base := "/channels/" + itoa(chID) + "/access/"
	if w := doRequest(t, handler, http.MethodGet, base+"explain?user_id="+itoa(uid), token, nil); w.Code != http.StatusForbidden {
		t.Errorf("explain = %d, want 403", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPost, base+"preview", token, map[string]any{"user_id": uid}); w.Code != http.StatusForbidden {
		t.Errorf("preview = %d, want 403", w.Code)
	}
}

// A MANAGE_CHANNELS holder below Administrator may explain or preview only a
// member ranked below them — the override editor's rank rule.
func TestAccessExplainAndPreview_RefuseHigherRankedMember(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "mod-explain")
	seniorID, _ := createRoleUser(t, database, 11, "Senior", permissions.ReadMessages, 80, "senior-explain")
	lowID, _ := createRoleUser(t, database, 12, "Junior", permissions.ReadMessages, 20, "junior-explain")
	chID, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	base := "/channels/" + itoa(chID) + "/access/"

	for _, c := range []struct {
		target int64
		want   int
	}{{lowID, http.StatusOK}, {seniorID, http.StatusForbidden}} {
		if w := doRequest(t, handler, http.MethodGet, base+"explain?action=view_channel&user_id="+itoa(c.target), modToken, nil); w.Code != c.want {
			t.Errorf("explain user %d = %d, want %d; body = %s", c.target, w.Code, c.want, w.Body.String())
		}
		if w := doRequest(t, handler, http.MethodPost, base+"preview", modToken, map[string]any{"user_id": c.target}); w.Code != c.want {
			t.Errorf("preview user %d = %d, want %d; body = %s", c.target, w.Code, c.want, w.Body.String())
		}
	}
}
