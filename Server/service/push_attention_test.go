package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// attentionPushFixture seeds an owner (user 1), an administrator (user 2) and a member (user 3).
func attentionPushFixture(t *testing.T) *pushDispatchFixture {
	t.Helper()
	f := newPushDispatchFixture(t)
	seedRole(t, f.database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner", Permissions: permissions.Administrator, Position: permissions.OwnerRolePosition})
	seedRole(t, f.database, &db.Role{ID: permissions.AdminRoleID, Name: "Admin", Permissions: permissions.Administrator, Position: 50})
	seedUserRole(t, f.database, 1, permissions.OwnerRoleID)
	seedUserRole(t, f.database, 2, permissions.AdminRoleID)
	seedUserRole(t, f.database, 3, permissions.MemberRoleID)
	return f
}

func TestSendAttention_OwnerGetsTheGenericPayloadOnly(t *testing.T) {
	f := attentionPushFixture(t)
	ownerSub := f.subscribe(t, 1, "https://push.example.net/owner")
	f.subscribe(t, 2, "https://push.example.net/admin")
	f.subscribe(t, 3, "https://push.example.net/member")
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)

	d.SendAttention(context.Background())

	if got := fetch.urls(); len(got) != 1 || got[0] != "https://push.example.net/owner" {
		t.Fatalf("fetched %v, want only the owner's endpoint (an administrator is not the owner)", got)
	}
	if got := string(ownerSub.decrypt(t, fetch.bodyFor("https://push.example.net/owner"))); got != `{"t":"attention"}` {
		t.Errorf("payload = %s, want exactly the generic one", got)
	}
	fetch.mu.Lock()
	h := fetch.calls[0].Header
	fetch.mu.Unlock()
	if h["TTL"] != "3600" || h["Urgency"] != "high" {
		t.Errorf("headers = %v, want TTL 3600 and Urgency high", h)
	}
	requireCounters(t, d, 1, 0, 0, "")
}

func TestSendAttention_NothingToSendIsNotAnError(t *testing.T) {
	f := attentionPushFixture(t)
	fetch := newRecordingPushFetcher()
	d := f.ringDispatcher(fetch)

	d.SendAttention(context.Background()) // the owner has no subscription
	f.subscribe(t, 2, "https://push.example.net/admin")
	d.SendAttention(context.Background()) // an administrator's subscription is not the owner's
	if len(fetch.urls()) != 0 {
		t.Fatalf("fetched %v, want nothing", fetch.urls())
	}

	seedUserRole(t, f.database, 1, permissions.MemberRoleID)
	f.subscribe(t, 1, "https://push.example.net/former-owner")
	d.SendAttention(context.Background()) // nobody holds the owner role any more
	if len(fetch.urls()) != 0 {
		t.Fatalf("fetched %v, want nothing without an owner", fetch.urls())
	}
	requireCounters(t, d, 0, 0, 0, "")
}

func TestSendAttention_RetriesAfterAServerError(t *testing.T) {
	f := attentionPushFixture(t)
	const endpoint = "https://push.example.net/owner"
	f.subscribe(t, 1, endpoint)
	fetch := newRecordingPushFetcher()
	fetch.sequence(endpoint, pushFetchResult{status: 503}, pushFetchResult{status: 201})
	d := f.ringDispatcher(fetch)

	d.SendAttention(context.Background())

	if fetch.countFor(endpoint) != 2 {
		t.Errorf("endpoint reached %d times, want a retry after the 503", fetch.countFor(endpoint))
	}
	requireCounters(t, d, 1, 0, 0, "")
}
