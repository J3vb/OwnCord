package api_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

type listedInvite struct {
	ID      int64  `json:"id"`
	Code    string `json:"code"`
	Revoked bool   `json:"revoked"`
}

func inviteTestAdmin(t *testing.T, name string) (http.Handler, *db.DB, string, int64) {
	t.Helper()
	database := newAuthTestDB(t)
	router := buildInviteRouter(database, auth.NewRateLimiter())
	token := loginAndGetToken(t, router, database, name, 2)
	u, err := database.GetUserByUsername(context.Background(), name)
	if err != nil || u == nil {
		t.Fatalf("lookup %s: %v", name, err)
	}
	return router, database, token, u.ID
}

func mustInvite(t *testing.T, database *db.DB, uid int64, maxUses int, expires *time.Time) string {
	t.Helper()
	code, err := database.CreateInvite(context.Background(), uid, maxUses, expires)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	return code
}

func listInvitesAt(t *testing.T, router http.Handler, token, query string) []listedInvite {
	t.Helper()
	rr := getWithToken(t, router, "/api/v1/invites"+query, token)
	requireStatus(t, rr, http.StatusOK)
	return decodeBody[[]listedInvite](t, rr)
}

func TestListInvites_OldLiveInviteSurvivesManyDeadOnes(t *testing.T) {
	router, database, token, uid := inviteTestAdmin(t, "listadmin1")
	oldLive := mustInvite(t, database, uid, 0, nil)
	for range 250 {
		code := mustInvite(t, database, uid, 0, nil)
		if err := database.RevokeInvite(context.Background(), code); err != nil {
			t.Fatalf("RevokeInvite: %v", err)
		}
	}

	got := listInvitesAt(t, router, token, "")
	if len(got) == 0 || got[0].Code != oldLive {
		t.Fatalf("first listed invite = %+v, want the old live invite %s", got, oldLive)
	}
	for _, inv := range got[1:] {
		if !inv.Revoked {
			t.Fatalf("a live invite listed after the dead ones: %+v", inv)
		}
	}
	if len(got) != 1+50 {
		t.Fatalf("default view has %d invites, want 1 live + 50 dead", len(got))
	}
}

func TestListInvites_DeadPagedByCursor(t *testing.T) {
	router, database, token, uid := inviteTestAdmin(t, "listadmin2")
	for range 25 {
		code := mustInvite(t, database, uid, 0, nil)
		if err := database.RevokeInvite(context.Background(), code); err != nil {
			t.Fatalf("RevokeInvite: %v", err)
		}
	}
	live := mustInvite(t, database, uid, 0, nil)

	seen := map[int64]bool{}
	before := ""
	pages := 0
	for {
		page := listInvitesAt(t, router, token, "?state=dead&limit=10"+before)
		for _, inv := range page {
			if seen[inv.ID] {
				t.Fatalf("invite %d on two pages", inv.ID)
			}
			if inv.Code == live || !inv.Revoked {
				t.Fatalf("live invite in the dead list: %+v", inv)
			}
			seen[inv.ID] = true
		}
		pages++
		if len(page) < 10 {
			break
		}
		before = fmt.Sprintf("&before=%d", page[len(page)-1].ID)
	}
	if len(seen) != 25 || pages != 3 {
		t.Fatalf("paged %d dead invites in %d pages, want 25 in 3", len(seen), pages)
	}
}

func TestListInvites_ExpiringInviteIsOnExactlyOneSide(t *testing.T) {
	router, database, token, uid := inviteTestAdmin(t, "listadmin3")
	soon := time.Now().Add(1100 * time.Millisecond)
	code := mustInvite(t, database, uid, 0, &soon)
	older := mustInvite(t, database, uid, 0, nil)
	if err := database.RevokeInvite(context.Background(), older); err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}

	first := listInvitesAt(t, router, token, "")
	if first[0].Code != code {
		t.Fatalf("expiring invite should be live in the first read: %+v", first)
	}
	time.Sleep(2200 * time.Millisecond)

	// Between the reads it expired: the dead page now carries it, so a client merging by id sees it once.
	dead := listInvitesAt(t, router, token, "?state=dead")
	live := listInvitesAt(t, router, token, "?state=live")
	inDead, inLive := false, false
	for _, inv := range dead {
		inDead = inDead || inv.Code == code
	}
	for _, inv := range live {
		inLive = inLive || inv.Code == code
	}
	if !inDead || inLive {
		t.Fatalf("expired invite: inDead=%v inLive=%v, want true/false", inDead, inLive)
	}
}

func TestListInvites_BadParams(t *testing.T) {
	router, _, token, _ := inviteTestAdmin(t, "listadmin4")
	for _, q := range []string{"?state=nope", "?before=x", "?before=-1", "?limit=-1", "?limit=x"} {
		rr := getWithToken(t, router, "/api/v1/invites"+q, token)
		expectStatus(t, rr, http.StatusBadRequest)
	}
}

func TestRevokeInviteByID(t *testing.T) {
	router, database, token, uid := inviteTestAdmin(t, "revadmin1")
	code := mustInvite(t, database, uid, 0, nil)
	inv, err := database.GetInvite(context.Background(), code)
	if err != nil || inv == nil {
		t.Fatalf("GetInvite: %v", err)
	}
	path := fmt.Sprintf("/api/v1/invites/id/%d", inv.ID)

	expectStatus(t, doAPI(t, router, http.MethodDelete, path, token, nil), http.StatusNoContent)
	// A second revoke of the same invite is idempotent.
	expectStatus(t, doAPI(t, router, http.MethodDelete, path, token, nil), http.StatusNoContent)
	got, _ := database.GetInvite(context.Background(), code)
	if got == nil || !got.Revoked {
		t.Fatal("invite not revoked after DELETE by id")
	}
}

func TestRevokeInviteByID_UnknownAndMalformed(t *testing.T) {
	router, _, token, _ := inviteTestAdmin(t, "revadmin2")
	for _, id := range []string{"99999", "0", "abc"} {
		rr := doAPI(t, router, http.MethodDelete, "/api/v1/invites/id/"+id, token, nil)
		expectStatus(t, rr, http.StatusNotFound)
	}
}

func TestRevokeInviteByID_MemberForbidden(t *testing.T) {
	router, database, adminToken, uid := inviteTestAdmin(t, "revadmin3")
	_ = adminToken
	code := mustInvite(t, database, uid, 0, nil)
	inv, _ := database.GetInvite(context.Background(), code)
	member := loginAndGetToken(t, router, database, "revmember", 4)

	rr := doAPI(t, router, http.MethodDelete, fmt.Sprintf("/api/v1/invites/id/%d", inv.ID), member, nil)
	expectStatus(t, rr, http.StatusForbidden)
	if got, _ := database.GetInvite(context.Background(), code); got == nil || got.Revoked {
		t.Fatal("a member revoked an invite")
	}
}

func TestCreateInvite_RateLimitedPerUser(t *testing.T) {
	router, database, token, _ := inviteTestAdmin(t, "rateadmin1")
	other := loginAndGetToken(t, router, database, "rateadmin2", 2)

	for i := range 20 {
		rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
		if rr.Code != http.StatusCreated {
			t.Fatalf("create %d: status %d, want 201", i+1, rr.Code)
		}
	}
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	expectStatus(t, rr, http.StatusTooManyRequests)
	// Another user has their own budget.
	expectStatus(t, postJSONWithToken(t, router, "/api/v1/invites", other, map[string]any{}), http.StatusCreated)
}
