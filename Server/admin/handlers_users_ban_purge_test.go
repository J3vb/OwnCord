package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// purgeOrderHub records the order of member_ban and chat_bulk_deleted
// broadcasts on top of mockHub.
type purgeOrderHub struct {
	*mockHub
	events []string
}

func (h *purgeOrderHub) BroadcastMemberBan(userID int64) {
	h.events = append(h.events, "ban")
	h.mockHub.BroadcastMemberBan(userID)
}

func (h *purgeOrderHub) BroadcastChatBulkDeleted(channelID int64, messageIDs []int64) {
	h.events = append(h.events, "bulk")
	h.mockHub.BroadcastChatBulkDeleted(channelID, messageIDs)
}

type banPurgeEnv struct {
	limiter  *auth.RateLimiter
	database *db.DB
	svc      *service.Services
	hub      *purgeOrderHub
	handler  http.Handler
}

func newBanPurgeEnv(t *testing.T) *banPurgeEnv {
	t.Helper()
	database := openMigratedAdminDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	hub := &purgeOrderHub{mockHub: &mockHub{}}
	return &banPurgeEnv{
		limiter:  limiter,
		database: database,
		svc:      svc,
		hub:      hub,
		handler:  admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, &mockPermInvalidator{}, svc),
	}
}

func (e *banPurgeEnv) channel(t *testing.T, name string) int64 {
	t.Helper()
	id, err := e.database.CreateChannel(context.Background(), name, "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(%s): %v", name, err)
	}
	return id
}

func (e *banPurgeEnv) message(t *testing.T, channelID, userID int64, content string) int64 {
	t.Helper()
	id, err := e.database.CreateMessage(context.Background(), channelID, userID, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage(%s): %v", content, err)
	}
	return id
}

func (e *banPurgeEnv) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := e.database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func (e *banPurgeEnv) banned(t *testing.T, userID int64) bool {
	t.Helper()
	u, err := e.database.GetUserByID(context.Background(), userID)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID(%d): %v", userID, err)
	}
	return u.Banned
}

func decodePatchBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode response: %v; body: %s", err, body)
	}
	return out
}

func purgeField(t *testing.T, body map[string]any) (deleted int, complete bool) {
	t.Helper()
	p, ok := body["purge"].(map[string]any)
	if !ok {
		t.Fatalf("response has no purge object: %v", body)
	}
	d, _ := p["deleted"].(float64)
	c, _ := p["complete"].(bool)
	return int(d), c
}

func sortedIDs(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return out
}

func TestPatchUser_BanWithDeleteSeconds_BanThenBulkDeletePerChannel(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "purge-owner", 1)
	targetID, _ := sessionFor(t, e.database, "purge-target", 4)
	otherID, _ := sessionFor(t, e.database, "purge-bystander", 4)

	chA := e.channel(t, "purge-a")
	chB := e.channel(t, "purge-b")
	a1 := e.message(t, chA, targetID, "a1")
	a2 := e.message(t, chA, targetID, "a2")
	b1 := e.message(t, chB, targetID, "b1")
	keep := e.message(t, chA, otherID, "keep")

	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken, map[string]any{
		"banned":                 true,
		"ban_reason":             "spam",
		"delete_message_seconds": 3600,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	body := decodePatchBody(t, w.Body.Bytes())
	if deleted, complete := purgeField(t, body); deleted != 3 || !complete {
		t.Fatalf("purge = {deleted:%d complete:%v}, want {3 true}", deleted, complete)
	}
	if body["banned"] != true {
		t.Errorf("banned = %v, want true", body["banned"])
	}

	if want := []string{"ban", "bulk", "bulk"}; !slices.Equal(e.hub.events, want) {
		t.Fatalf("broadcast order = %v, want %v (member_ban first, then one chat_bulk_deleted per channel)", e.hub.events, want)
	}
	got := map[int64][]int64{}
	for _, c := range e.hub.bulkDeletes {
		got[c.channelID] = sortedIDs(c.messageIDs)
	}
	if !slices.Equal(got[chA], sortedIDs([]int64{a1, a2})) || !slices.Equal(got[chB], []int64{b1}) {
		t.Fatalf("bulk deletes = %v, want channel %d -> [%d %d], channel %d -> [%d]", got, chA, a1, a2, chB, b1)
	}

	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 0`, targetID); n != 0 {
		t.Errorf("target still has %d live messages", n)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE id = ? AND deleted = 0`, keep); n != 1 {
		t.Errorf("another member's message was deleted")
	}
	if n := e.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'user_ban_purge' AND target_id = ?`, targetID); n != 1 {
		t.Errorf("user_ban_purge audit rows = %d, want 1", n)
	}
}

func TestPatchUser_DeleteSecondsOutOfRange_400_NotBanned(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "range-owner", 1)
	targetID, _ := sessionFor(t, e.database, "range-target", 4)
	ch := e.channel(t, "range-a")
	e.message(t, ch, targetID, "hello")

	for _, raw := range []string{"-1", "604801", "1.5", `"60"`} {
		w := doRequestRaw(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken,
			`{"banned":true,"delete_message_seconds":`+raw+`}`)
		if w.Code != http.StatusBadRequest {
			t.Errorf("delete_message_seconds=%s: status = %d, want 400; body: %s", raw, w.Code, w.Body.String())
		}
		if e.banned(t, targetID) {
			t.Fatalf("delete_message_seconds=%s: target was banned by a refused request", raw)
		}
	}
	if len(e.hub.events) != 0 {
		t.Errorf("broadcasts = %v, want none", e.hub.events)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 1`, targetID); n != 0 {
		t.Errorf("%d messages deleted by refused requests", n)
	}

	// The bounds themselves are accepted.
	for _, secs := range []int{604800} {
		w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken,
			map[string]any{"banned": true, "delete_message_seconds": secs})
		if w.Code != http.StatusOK {
			t.Errorf("delete_message_seconds=%d: status = %d, want 200; body: %s", secs, w.Code, w.Body.String())
		}
	}
}

func TestPatchUser_DeleteSecondsWithoutBanned_400(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "nobanned-owner", 1)
	targetID, _ := sessionFor(t, e.database, "nobanned-target", 4)
	ch := e.channel(t, "nobanned-a")
	e.message(t, ch, targetID, "hello")

	for name, body := range map[string]map[string]any{
		"field alone":       {"delete_message_seconds": 60},
		"with banned false": {"banned": false, "delete_message_seconds": 60},
		"with a role only":  {"role_id": 2, "delete_message_seconds": 60},
	} {
		w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body: %s", name, w.Code, w.Body.String())
		}
	}
	if e.banned(t, targetID) {
		t.Error("target was banned")
	}
	u, _ := e.database.GetUserByID(context.Background(), targetID)
	if u.RoleID != 4 {
		t.Errorf("role_id = %d, want 4 (a refused request changes nothing)", u.RoleID)
	}
	if len(e.hub.events) != 0 || len(e.hub.memberUpdates) != 0 {
		t.Errorf("broadcasts = %v / %v, want none", e.hub.events, e.hub.memberUpdates)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 1`, targetID); n != 0 {
		t.Errorf("%d messages deleted by refused requests", n)
	}
}

func TestPatchUser_DeleteSecondsWithoutManageMessages_403_NotBanned(t *testing.T) {
	e := newBanPurgeEnv(t)
	// BAN_MEMBERS (bit 19) without MANAGE_MESSAGES (bit 16), below Admin.
	_, modToken := createRoleUser(t, e.database, 10, "BanOnly", moderatorMask&^permissions.ManageMessages, 60, "purge-banonly")
	targetID, _ := sessionFor(t, e.database, "nomanage-target", 4)
	ch := e.channel(t, "nomanage-a")
	e.message(t, ch, targetID, "hello")

	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), modToken, map[string]any{
		"banned":                 true,
		"delete_message_seconds": 3600,
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if e.banned(t, targetID) {
		t.Fatal("target was banned by a refused request")
	}
	if len(e.hub.events) != 0 {
		t.Errorf("broadcasts = %v, want none", e.hub.events)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 1`, targetID); n != 0 {
		t.Errorf("%d messages deleted by a refused request", n)
	}

	// The same moderator can still ban without asking for the deletion.
	w = doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), modToken, map[string]any{"banned": true})
	if w.Code != http.StatusOK {
		t.Fatalf("plain ban: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

func TestPatchUser_DeleteSecondsRateLimited_429_NotBanned(t *testing.T) {
	e := newBanPurgeEnv(t)
	ownerID, ownerToken := sessionFor(t, e.database, "limit-owner", 1)
	firstID, _ := sessionFor(t, e.database, "limit-first", 4)
	secondID, _ := sessionFor(t, e.database, "limit-second", 4)

	body := map[string]any{"banned": true, "delete_message_seconds": 60}
	if w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(firstID), ownerToken, body); w.Code != http.StatusOK {
		t.Fatalf("first: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	// Same key AuthorizeBanPurge uses; the lockout makes the refusal
	// independent of timing.
	e.limiter.Lockout(context.Background(), auth.Key("ban_purge", ownerID), time.Hour)
	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(secondID), ownerToken, body)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("second: status = %d, want 429; body: %s", w.Code, w.Body.String())
	}
	if e.banned(t, secondID) {
		t.Error("the rate-limited request banned its target")
	}
}

func TestPatchUser_BanWithoutDeleteSeconds_ResponseUnchanged(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "plain-owner", 1)
	targetID, _ := sessionFor(t, e.database, "plain-target", 4)
	zeroID, _ := sessionFor(t, e.database, "plain-zero", 4)
	ch := e.channel(t, "plain-a")
	e.message(t, ch, targetID, "stays")
	e.message(t, ch, zeroID, "stays too")

	for _, tc := range []struct {
		id   int64
		body map[string]any
	}{
		{targetID, map[string]any{"banned": true, "ban_reason": "spam"}},
		{zeroID, map[string]any{"banned": true, "delete_message_seconds": 0}},
	} {
		w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(tc.id), ownerToken, tc.body)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
		}
		got := decodePatchBody(t, w.Body.Bytes())
		if _, has := got["purge"]; has {
			t.Errorf("response has a purge member: %v", got)
		}
		if got["banned"] != true || got["id"] != float64(tc.id) {
			t.Errorf("response = %v, want the banned user object", got)
		}
	}
	if len(e.hub.bulkDeletes) != 0 {
		t.Errorf("bulk deletes = %v, want none", e.hub.bulkDeletes)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE deleted = 1`); n != 0 {
		t.Errorf("%d messages deleted without the field", n)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'user_ban_purge'`); n != 0 {
		t.Errorf("user_ban_purge audit rows = %d, want 0", n)
	}
}

func TestMemberAPI_BanWithDeleteSeconds(t *testing.T) {
	e := newBanPurgeEnv(t)
	handler := admin.NewMemberAPI(e.svc, e.hub, &mockPermInvalidator{})
	_, ownerToken := sessionFor(t, e.database, "member-api-owner", 1)
	targetID, _ := sessionFor(t, e.database, "member-api-target", 4)
	ch := e.channel(t, "member-api-a")
	m1 := e.message(t, ch, targetID, "one")
	m2 := e.message(t, ch, targetID, "two")

	w := doRequestRaw(t, handler, http.MethodPatch, "/"+itoa(targetID), ownerToken,
		`{"banned":true,"delete_message_seconds":1.5}`)
	if w.Code != http.StatusBadRequest || e.banned(t, targetID) {
		t.Fatalf("1.5: status = %d banned = %v, want 400 and not banned", w.Code, e.banned(t, targetID))
	}

	w = doRequest(t, handler, http.MethodPatch, "/"+itoa(targetID), ownerToken, map[string]any{
		"banned":                 true,
		"delete_message_seconds": 86400,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if deleted, complete := purgeField(t, decodePatchBody(t, w.Body.Bytes())); deleted != 2 || !complete {
		t.Fatalf("purge = {deleted:%d complete:%v}, want {2 true}", deleted, complete)
	}
	if want := []string{"ban", "bulk"}; !slices.Equal(e.hub.events, want) {
		t.Fatalf("broadcast order = %v, want %v", e.hub.events, want)
	}
	if len(e.hub.bulkDeletes) != 1 || e.hub.bulkDeletes[0].channelID != ch ||
		!slices.Equal(sortedIDs(e.hub.bulkDeletes[0].messageIDs), []int64{m1, m2}) {
		t.Fatalf("bulk deletes = %v, want channel %d -> [%d %d]", e.hub.bulkDeletes, ch, m1, m2)
	}
}

func TestPatchUser_DeleteSecondsOnAlreadyBannedTarget_SkipsSecondBanWrite(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "retry-owner", 1)
	_, adminToken := sessionFor(t, e.database, "retry-admin", 2)
	targetID, _ := sessionFor(t, e.database, "retry-target", 4)
	ch := e.channel(t, "retry-a")

	banRows := func() int {
		return e.count(t, `SELECT COUNT(*) FROM moderation_actions WHERE kind = 'ban' AND target_id = ?`, targetID)
	}
	banAudits := func() int {
		return e.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'user_ban' AND target_id = ?`, targetID)
	}

	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken,
		map[string]any{"banned": true, "ban_reason": "spam"})
	if w.Code != http.StatusOK {
		t.Fatalf("ban: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if banRows() != 1 {
		t.Fatalf("ban ledger rows = %d, want 1", banRows())
	}

	// Same ban values, now asking for the deletion: the ban is not rewritten.
	m1 := e.message(t, ch, targetID, "late one")
	w = doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), adminToken,
		map[string]any{"banned": true, "ban_reason": "spam", "delete_message_seconds": 3600})
	if w.Code != http.StatusOK {
		t.Fatalf("retry: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if deleted, complete := purgeField(t, decodePatchBody(t, w.Body.Bytes())); deleted != 1 || !complete {
		t.Fatalf("retry purge = {deleted:%d complete:%v}, want {1 true}", deleted, complete)
	}
	if banRows() != 1 || banAudits() != 1 {
		t.Errorf("after retry: ban ledger rows = %d, user_ban audits = %d, want 1 and 1", banRows(), banAudits())
	}
	if len(e.hub.memberBanIDs) != 1 {
		t.Errorf("member_ban broadcasts = %v, want only the first", e.hub.memberBanIDs)
	}
	if len(e.hub.bulkDeletes) != 1 || !slices.Equal(e.hub.bulkDeletes[0].messageIDs, []int64{m1}) {
		t.Errorf("bulk deletes = %v, want [%d]", e.hub.bulkDeletes, m1)
	}
	u, _ := e.database.GetUserByID(context.Background(), targetID)
	if u.BanReason == nil || *u.BanReason != "spam" {
		t.Errorf("ban_reason = %v, want spam (unchanged)", u.BanReason)
	}

	// A different reason is a change: the ban is written again.
	e.message(t, ch, targetID, "another")
	w = doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken,
		map[string]any{"banned": true, "ban_reason": "harassment", "delete_message_seconds": 3600})
	if w.Code != http.StatusOK {
		t.Fatalf("changed retry: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if banRows() != 2 {
		t.Errorf("ban ledger rows = %d, want 2 after the reason changed", banRows())
	}
}

func TestPatchUser_InvalidBanFieldsDoNotSpendPurgeToken(t *testing.T) {
	e := newBanPurgeEnv(t)
	_, ownerToken := sessionFor(t, e.database, "token-owner", 1)
	targetID, _ := sessionFor(t, e.database, "token-target", 4)

	for name, body := range map[string]map[string]any{
		"hours out of range": {"banned": true, "ban_duration_hours": 99999, "delete_message_seconds": 60},
		"reason too long":    {"banned": true, "ban_reason": strings.Repeat("a", 5000), "delete_message_seconds": 60},
	} {
		w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken, body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400; body: %s", name, w.Code, w.Body.String())
		}
	}
	if e.banned(t, targetID) {
		t.Fatal("a refused request banned the target")
	}

	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken,
		map[string]any{"banned": true, "ban_duration_hours": 24, "delete_message_seconds": 60})
	if w.Code != http.StatusOK {
		t.Fatalf("corrected request: status = %d, want 200 (the 400s must not spend the rate-limit token); body: %s", w.Code, w.Body.String())
	}
}

func TestPatchUser_PartialPurge_ReportsIncompleteThenContinues(t *testing.T) {
	e := newBanPurgeEnv(t)
	e.svc.Moderation.SetBanPurgeRowCapForTest(2)
	_, ownerToken := sessionFor(t, e.database, "partial-owner", 1)
	// A second actor for the repeat: one purge per actor every 2 seconds.
	_, adminToken := sessionFor(t, e.database, "partial-admin", 2)
	targetID, _ := sessionFor(t, e.database, "partial-target", 4)
	ch := e.channel(t, "partial-a")
	for _, c := range []string{"one", "two", "three"} {
		e.message(t, ch, targetID, c)
	}
	banRows := func() int {
		return e.count(t, `SELECT COUNT(*) FROM moderation_actions WHERE kind = 'ban' AND target_id = ?`, targetID)
	}
	body := map[string]any{"banned": true, "ban_reason": "spam", "delete_message_seconds": 3600}

	w := doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), ownerToken, body)
	if w.Code != http.StatusOK {
		t.Fatalf("first: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if deleted, complete := purgeField(t, decodePatchBody(t, w.Body.Bytes())); deleted != 2 || complete {
		t.Fatalf("first purge = {deleted:%d complete:%v}, want {2 false}", deleted, complete)
	}
	// The cap is below the batch size, so the one batch holds the two rows.
	if len(e.hub.bulkDeletes) != 1 || len(e.hub.bulkDeletes[0].messageIDs) != 2 || e.hub.bulkDeletes[0].channelID != ch {
		t.Fatalf("bulk deletes = %v, want one batch of 2 in channel %d", e.hub.bulkDeletes, ch)
	}
	if n := e.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 0`, targetID); n != 1 {
		t.Fatalf("live messages = %d, want 1", n)
	}

	w = doRequest(t, e.handler, http.MethodPatch, "/users/"+itoa(targetID), adminToken, body)
	if w.Code != http.StatusOK {
		t.Fatalf("repeat: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if deleted, complete := purgeField(t, decodePatchBody(t, w.Body.Bytes())); deleted != 1 || !complete {
		t.Fatalf("repeat purge = {deleted:%d complete:%v}, want {1 true}", deleted, complete)
	}
	if len(e.hub.bulkDeletes) != 2 {
		t.Errorf("bulk deletes = %d, want 2 batches in total", len(e.hub.bulkDeletes))
	}
	if banRows() != 1 {
		t.Errorf("ban ledger rows = %d, want 1 (the repeat does not rewrite the ban)", banRows())
	}
}
