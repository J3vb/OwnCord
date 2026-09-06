package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// recordingModQueueBroadcaster satisfies api.ModQueueBroadcaster and records
// every call, so the queue's act route's post-commit transport (P2-7, Codex
// review) can be asserted directly without a live WS connection.
type recordingModQueueBroadcaster struct {
	bans        []int64
	bulkDeletes []actTestBulkDelete
}

type actTestBulkDelete struct {
	channelID int64
	ids       []int64
}

func (b *recordingModQueueBroadcaster) BroadcastModQueue(context.Context, int64, string) {}
func (b *recordingModQueueBroadcaster) BroadcastMemberBan(userID int64) {
	b.bans = append(b.bans, userID)
}
func (b *recordingModQueueBroadcaster) BroadcastChatBulkDeleted(channelID int64, ids []int64) {
	b.bulkDeletes = append(b.bulkDeletes, actTestBulkDelete{channelID: channelID, ids: ids})
}

// buildModQueueActRouter wires reports, the moderation queue and the direct
// moderation routes onto one fresh migrated DB and a recording broadcaster —
// everything the P1-5/P2-6/P2-7 tests below need, without the full
// app.StartRuntime hub (BroadcastMemberBan/BroadcastChatBulkDeleted are
// captured directly instead of observed through a live socket).
func buildModQueueActRouter(t *testing.T) (http.Handler, *db.DB, *recordingModQueueBroadcaster) {
	t.Helper()
	database := newModQueueActTestDB(t)
	broadcaster := &recordingModQueueBroadcaster{}
	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountReportRoutes(r, svc, broadcaster)
	api.MountModerationQueueRoutes(r, svc, broadcaster)
	api.MountModerationRoutes(r, svc)
	return r, database, broadcaster
}

// newModQueueActTestDB opens a fully migrated in-memory database.
func newModQueueActTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// mintModerator creates a role with the given position and permission bits
// (always including READ_MESSAGES so channel-target reports resolve) and a
// user holding it.
func mintModerator(t *testing.T, database *db.DB, username string, position int, perms int64) int64 {
	t.Helper()
	role, err := database.CreateRole(context.Background(), username+"-role", nil, perms|permissions.ReadMessages, position)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	userID := mintUser(t, database, username)
	if err := database.UpdateUserRole(context.Background(), userID, role.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	return userID
}

// actJSON issues an authenticated JSON request and decodes the response.
func actJSON(t *testing.T, h http.Handler, method, path, token, body string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// fileUserReport files a report against a user target through the real
// intake route and returns its PUBLIC id.
func fileUserReport(t *testing.T, h http.Handler, reporterToken string, targetUserID int64) string {
	t.Helper()
	body := `{"target_type":"user","target_id":"` + itoa(targetUserID) + `","reason":"spam"}`
	status, respBody := actJSON(t, h, http.MethodPost, "/api/v1/reports", reporterToken, body)
	if status != http.StatusCreated {
		t.Fatalf("file report: status = %d, body = %s", status, respBody)
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &resp); err != nil {
		t.Fatalf("unmarshal file-report response: %v", err)
	}
	return resp.ID
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// TestModerationQueueAct_SelfReviewRefused is P2-6 (Codex review): the act
// route uses Reports.Get, which allows the report's own REPORTER to read it
// (it is their own filing) — but acting on it is the same conflict of
// interest Assign/Note/Close already refuse. A moderator who files a report
// and then tries to act on it themselves must see 403 SELF_REVIEW, not a
// successful warning.
func TestModerationQueueAct_SelfReviewRefused(t *testing.T) {
	h, database, _ := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-selfreview-mod", 80, permissions.ModerateMembers)
	modToken, _ := mintSession(t, database, modID)
	victimID := mintUser(t, database, "act-selfreview-victim")

	publicID := fileUserReport(t, h, modToken, victimID)

	status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"warning","reason":"be nice"}`)
	if status != http.StatusForbidden {
		t.Fatalf("act on own filed report: status = %d, body = %s, want 403", status, body)
	}
	var resp struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &resp)
	if resp.Error != "SELF_REVIEW" {
		t.Fatalf("act on own filed report: error = %q, want SELF_REVIEW (body: %s)", resp.Error, body)
	}
}

// TestModerationQueueAct_BanBroadcastsMemberBan is P2-7's ban half: acting
// through the queue must send the same member_ban broadcast the direct admin
// ban route sends, which this used to drop entirely.
func TestModerationQueueAct_BanBroadcastsMemberBan(t *testing.T) {
	h, database, broadcaster := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-ban-mod", 90, permissions.ModerateMembers|permissions.BanMembers)
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-ban-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	targetID := mintUser(t, database, "act-ban-target")

	publicID := fileUserReport(t, h, reporterToken, targetID)

	status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"ban","reason":"repeated spam"}`)
	if status != http.StatusNoContent {
		t.Fatalf("act(ban): status = %d, body = %s, want 204", status, body)
	}
	if len(broadcaster.bans) != 1 || broadcaster.bans[0] != targetID {
		t.Fatalf("BroadcastMemberBan calls = %v, want exactly [%d]", broadcaster.bans, targetID)
	}
	target, err := database.GetUserByID(context.Background(), targetID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !target.Banned {
		t.Fatal("target not banned after act(ban)")
	}
}

// TestModerationQueueAct_NoBroadcastWhenActionFails is a P2-7 test gap
// (Codex review round 3): the act route must not broadcast anything when
// the underlying service call fails — here, an actor holding MODERATE_
// MEMBERS (enough to pass the route's own gate and read the report) but
// lacking BAN_MEMBERS, so banUser's own permission check refuses before any
// write is attempted.
func TestModerationQueueAct_NoBroadcastWhenActionFails(t *testing.T) {
	h, database, broadcaster := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-nobroadcast-mod", 90, permissions.ModerateMembers) // no BanMembers
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-nobroadcast-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	targetID := mintUser(t, database, "act-nobroadcast-target")

	publicID := fileUserReport(t, h, reporterToken, targetID)

	status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"ban","reason":"repeated spam"}`)
	if status != http.StatusForbidden {
		t.Fatalf("act(ban) without BAN_MEMBERS: status = %d, body = %s, want 403", status, body)
	}
	if len(broadcaster.bans) != 0 {
		t.Fatalf("BroadcastMemberBan calls = %v, want none — the ban was refused, nothing should have landed", broadcaster.bans)
	}
	target, err := database.GetUserByID(context.Background(), targetID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if target.Banned {
		t.Fatal("target is banned despite the refused act(ban)")
	}
}

// TestModerationQueueAct_NoBroadcastWhenBanWriteFails is the sibling Codex
// review asked for: the existing no-broadcast test above only ever exercises
// a PERMISSION refusal (403, before any write is attempted) — it proves
// nothing about whether a genuine DB write failure, after authorization
// already passed, is also handled without a stray broadcast. Dropping the
// ledger table the ban's own transaction writes to (BanUserWithAction is
// one transaction covering both the ban and its ledger row) forces the
// write itself to fail with an actor who otherwise holds BAN_MEMBERS.
func TestModerationQueueAct_NoBroadcastWhenBanWriteFails(t *testing.T) {
	h, database, broadcaster := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-banwritefail-mod", 90, permissions.ModerateMembers|permissions.BanMembers)
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-banwritefail-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	targetID := mintUser(t, database, "act-banwritefail-target")

	publicID := fileUserReport(t, h, reporterToken, targetID)

	if _, err := database.ExecContext(context.Background(), `DROP TABLE moderation_actions`); err != nil {
		t.Fatalf("DROP TABLE moderation_actions: %v", err)
	}

	status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"ban","reason":"repeated spam"}`)
	if status == http.StatusOK || status == http.StatusNoContent {
		t.Fatalf("act(ban) with the ledger table gone: status = %d, body = %s, want a failure status", status, body)
	}
	if len(broadcaster.bans) != 0 {
		t.Fatalf("BroadcastMemberBan calls = %v, want none — the write failed, nothing should have landed", broadcaster.bans)
	}
	target, err := database.GetUserByID(context.Background(), targetID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if target.Banned {
		t.Fatal("target is banned despite the ledger write failing — BanUserWithAction's transaction did not roll back")
	}
}

// TestModerationQueueAct_NoBroadcastWhenRemovalWriteFails is
// TestModerationQueueAct_NoBroadcastWhenBanWriteFails's removal twin: same
// dropped ledger table (recordLedgerRow's own write target), an actor who
// otherwise holds MANAGE_MESSAGES.
func TestModerationQueueAct_NoBroadcastWhenRemovalWriteFails(t *testing.T) {
	h, database, broadcaster := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-removalwritefail-mod", 90, permissions.ModerateMembers|permissions.ManageMessages)
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-removalwritefail-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	authorID := mintUser(t, database, "act-removalwritefail-author")

	chID, err := database.CreateChannel(context.Background(), "act-removalwritefail-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgID, err := database.CreateMessage(context.Background(), chID, authorID, "reported content", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	body := `{"target_type":"message","target_id":"` + itoa(msgID) + `","reason":"spam"}`
	status, respBody := actJSON(t, h, http.MethodPost, "/api/v1/reports", reporterToken, body)
	if status != http.StatusCreated {
		t.Fatalf("file report: status = %d, body = %s", status, respBody)
	}
	var fileResp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &fileResp); err != nil {
		t.Fatalf("unmarshal file-report response: %v", err)
	}

	if _, err := database.ExecContext(context.Background(), `DROP TABLE moderation_actions`); err != nil {
		t.Fatalf("DROP TABLE moderation_actions: %v", err)
	}

	status, actBody := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+fileResp.ID+"/act", modToken,
		`{"kind":"removal","reason":"rule violation"}`)
	if status == http.StatusOK || status == http.StatusNoContent {
		t.Fatalf("act(removal) with the ledger table gone: status = %d, body = %s, want a failure status", status, actBody)
	}
	if len(broadcaster.bulkDeletes) != 0 {
		t.Fatalf("BroadcastChatBulkDeleted calls = %+v, want none — the write failed, nothing should have landed", broadcaster.bulkDeletes)
	}
	msg, err := database.GetMessage(context.Background(), msgID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Deleted {
		t.Fatal("the reported message was deleted despite the ledger write failing")
	}
}

// TestModerationQueueAct_RemovalBroadcastsChatBulkDeleted is P2-7's removal
// half: acting through the queue must send a chat_bulk_deleted broadcast for
// the removed message — the direct purge route's own broadcast, reused
// rather than reimplemented — which this used to drop entirely.
func TestModerationQueueAct_RemovalBroadcastsChatBulkDeleted(t *testing.T) {
	h, database, broadcaster := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-removal-mod", 90, permissions.ModerateMembers|permissions.ManageMessages)
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-removal-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	authorID := mintUser(t, database, "act-removal-author")

	chID, err := database.CreateChannel(context.Background(), "act-removal-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgID, err := database.CreateMessage(context.Background(), chID, authorID, "reported content", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	body := `{"target_type":"message","target_id":"` + itoa(msgID) + `","reason":"spam"}`
	status, respBody := actJSON(t, h, http.MethodPost, "/api/v1/reports", reporterToken, body)
	if status != http.StatusCreated {
		t.Fatalf("file report: status = %d, body = %s", status, respBody)
	}
	var fileResp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &fileResp); err != nil {
		t.Fatalf("unmarshal file-report response: %v", err)
	}

	status, actBody := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+fileResp.ID+"/act", modToken,
		`{"kind":"removal","reason":"rule violation"}`)
	if status != http.StatusNoContent {
		t.Fatalf("act(removal): status = %d, body = %s, want 204", status, actBody)
	}
	if len(broadcaster.bulkDeletes) != 1 || broadcaster.bulkDeletes[0].channelID != chID ||
		len(broadcaster.bulkDeletes[0].ids) != 1 || broadcaster.bulkDeletes[0].ids[0] != msgID {
		t.Fatalf("BroadcastChatBulkDeleted calls = %+v, want exactly [{channel=%d ids=[%d]}]",
			broadcaster.bulkDeletes, chID, msgID)
	}
	msg, err := database.GetMessage(context.Background(), msgID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if !msg.Deleted {
		t.Fatal("the reported message was not deleted")
	}
}

// TestModerationQueueAct_TimeoutExposesVoiceOutcome is P2-7's timeout half:
// the act route's response must expose the voice outcome exactly like the
// direct timeout route does, rather than a bare 204 that drops it.
func TestModerationQueueAct_TimeoutExposesVoiceOutcome(t *testing.T) {
	h, database, _ := buildModQueueActRouter(t)
	modID := mintModerator(t, database, "act-timeout-mod", 90, permissions.ModerateMembers)
	modToken, _ := mintSession(t, database, modID)
	reporterID := mintUser(t, database, "act-timeout-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)
	targetID := mintUser(t, database, "act-timeout-target")

	publicID := fileUserReport(t, h, reporterToken, targetID)

	status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
		`{"kind":"timeout","reason":"cool off","duration_seconds":3600}`)
	if status != http.StatusOK {
		t.Fatalf("act(timeout): status = %d, body = %s, want 200", status, body)
	}
	var resp struct {
		Voice string `json:"voice"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal act(timeout) response: %v", err)
	}
	// The target is not in any voice channel, so the voice half is skipped
	// (P1-3/P3-14) — "skipped", never silently absent.
	if resp.Voice != "skipped" {
		t.Fatalf("act(timeout) response.Voice = %q, want %q (body: %s)", resp.Voice, "skipped", body)
	}
}

// TestModerationLedger_ReportIDHiddenForConfidentialSubject is P1-5 (Codex
// review): GET /api/v1/moderation/users/{id}/actions renders a linked
// report's PUBLIC id with no per-row check of its own, so a moderator who is
// the SUBJECT of a report linked from their own action ledger could read
// that report's id just by holding MODERATE_MEMBERS. The id must be omitted
// for them while a different moderator (not the subject) still sees it.
func TestModerationLedger_ReportIDHiddenForConfidentialSubject(t *testing.T) {
	h, database, _ := buildModQueueActRouter(t)
	// modA outranks modB and issues the warning; modB is both the ledger
	// owner AND the report's confidential subject.
	modAID := mintModerator(t, database, "ledger-mod-a", 90, permissions.ModerateMembers)
	modAToken, _ := mintSession(t, database, modAID)
	modBID := mintModerator(t, database, "ledger-mod-b", 50, permissions.ModerateMembers)
	modBToken, _ := mintSession(t, database, modBID)
	reporterID := mintUser(t, database, "ledger-reporter")
	reporterToken, _ := mintSession(t, database, reporterID)

	publicID := fileUserReport(t, h, reporterToken, modBID)

	status, actBody := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modAToken,
		`{"kind":"warning","reason":"be nice"}`)
	if status != http.StatusNoContent {
		t.Fatalf("act(warning): status = %d, body = %s, want 204", status, actBody)
	}

	// The SUBJECT's own read: report_id must be absent.
	status, subjectBody := actJSON(t, h, http.MethodGet, "/api/v1/moderation/users/"+itoa(modBID)+"/actions", modBToken, "")
	if status != http.StatusOK {
		t.Fatalf("GET actions (subject): status = %d, body = %s", status, subjectBody)
	}
	if strings.Contains(string(subjectBody), `"report_id"`) {
		t.Fatalf("GET actions (subject) body contains report_id, want it omitted: %s", subjectBody)
	}

	// Positive control: a DIFFERENT moderator (not the subject) reading the
	// exact same ledger still sees the report id — the fix hides it for the
	// confidential subject specifically, not unconditionally.
	status, otherBody := actJSON(t, h, http.MethodGet, "/api/v1/moderation/users/"+itoa(modBID)+"/actions", modAToken, "")
	if status != http.StatusOK {
		t.Fatalf("GET actions (non-subject): status = %d, body = %s", status, otherBody)
	}
	if !strings.Contains(string(otherBody), `"report_id"`) {
		t.Fatalf("GET actions (non-subject) body missing report_id, want it present: %s", otherBody)
	}
}
