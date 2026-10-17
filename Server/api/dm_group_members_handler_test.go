package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// recordingBroadcaster logs every frame the group handlers send, in order, so a
// test can assert the fan-out order the design fixes: refreshed opens first,
// then the system rows.
type recordingBroadcaster struct {
	mu     sync.Mutex
	events []recordedEvent
	marks  int
	evicts []evictCall
}

type recordedEvent struct {
	kind    string // "open", "close" or "rows"
	user    int64  // the addressee of an open or close
	payload map[string]any
	// rows and audience are set for "rows".
	channelID int64
	audience  []int64
	rows      []service.GroupEventRow
}

func (b *recordingBroadcaster) SendToUser(userID int64, msg []byte) bool {
	var env struct {
		Type    string         `json:"type"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		return false
	}
	kind := map[string]string{ws.MsgTypeDMChannelOpen: "open", ws.MsgTypeDMChannelClose: "close"}[env.Type]
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, recordedEvent{kind: kind, user: userID, payload: env.Payload})
	return true
}

func (b *recordingBroadcaster) MarkVisibilityChanged() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.marks++
}

func (b *recordingBroadcaster) DisconnectFromVoiceInChannel(_ context.Context, userID, channelID int64, reason string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.evicts = append(b.evicts, evictCall{userID, channelID, reason})
	return true
}

func (b *recordingBroadcaster) GroupEventRows(_ context.Context, channelID int64, audience []int64, rows []service.GroupEventRow) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, recordedEvent{kind: "rows", channelID: channelID, audience: slices.Clone(audience), rows: rows})
}

func (b *recordingBroadcaster) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events, b.marks, b.evicts = nil, 0, nil
}

// kinds lists the logged event kinds with their addressee, e.g. "open:2".
func (b *recordingBroadcaster) kinds() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.events))
	for _, e := range b.events {
		if e.kind == "rows" {
			out = append(out, "rows")
			continue
		}
		out = append(out, fmt.Sprintf("%s:%d", e.kind, e.user))
	}
	return out
}

func (b *recordingBroadcaster) find(kind string, user int64) *recordedEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.events {
		if b.events[i].kind == kind && (kind == "rows" || b.events[i].user == user) {
			return &b.events[i]
		}
	}
	return nil
}

func dmDo(t *testing.T, router http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func buildLimitedDMRouter(database *db.DB, bc api.DMBroadcaster, limiter *auth.RateLimiter) http.Handler {
	r := chi.NewRouter()
	api.MountDMRoutes(r, database, service.New(database, auth.NewRateLimiter()), bc, limiter)
	return r
}

// membersFixture is a group of alice (1, owner), bob (2) and carol (3), with
// dave (4) and erin (5) outside it.
type membersFixture struct {
	database *db.DB
	router   http.Handler
	bc       *recordingBroadcaster
	tokens   []string // alice, bob, carol, dave, erin
	group    int64
}

func newMembersFixture(t *testing.T) *membersFixture {
	t.Helper()
	database := newDMTestDB(t)
	bc := &recordingBroadcaster{}
	router := buildLimitedDMRouter(database, bc, nil)
	tokens := make([]string, 0, 5)
	for _, name := range []string{"alice", "bob", "carol", "dave", "erin"} {
		tokens = append(tokens, dmCreateToken(t, database, name, 4))
	}
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.reset()
	return &membersFixture{database: database, router: router, bc: bc, tokens: tokens, group: group.ChannelID}
}

func (f *membersFixture) path(suffix string) string {
	return fmt.Sprintf("/api/v1/dms/%d%s", f.group, suffix)
}

func (f *membersFixture) add(t *testing.T, tokenIdx int, ids ...int64) *httptest.ResponseRecorder {
	t.Helper()
	return dmDo(t, f.router, http.MethodPost, f.path("/members"), f.tokens[tokenIdx], map[string]any{"user_ids": ids})
}

func (f *membersFixture) groupRowCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group).Scan(&n); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	return n
}

// ─── add ────────────────────────────────────────────────────────────────────

func TestAddMembers_AddedUserGetsOpenBeforeRow(t *testing.T) {
	f := newMembersFixture(t)
	rr := f.add(t, 1, 4) // bob, not the owner, adds dave
	if rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}
	info := decodeDMInfo(t, rr)
	if info.OwnerID != 1 || len(info.Recipients) != 3 {
		t.Errorf("response = owner %d, %d recipients, want owner 1 and 3 recipients (bob's view of 4 members)", info.OwnerID, len(info.Recipients))
	}

	kinds := f.bc.kinds()
	rowsAt := slices.Index(kinds, "rows")
	if rowsAt < 0 {
		t.Fatalf("no rows were delivered: %v", kinds)
	}
	if daveAt := slices.Index(kinds, "open:4"); daveAt < 0 || daveAt > rowsAt {
		t.Errorf("dave's dm_channel_open must precede the rows: %v", kinds)
	}
	rows := f.bc.find("rows", 0)
	if rows.channelID != f.group || !slices.Equal(rows.audience, []int64{1, 2, 3, 4}) {
		t.Errorf("rows delivered to %v in channel %d", rows.audience, rows.channelID)
	}
	if len(rows.rows) != 1 || rows.rows[0].Kind != "group_add" || rows.rows[0].TargetUserID != 4 || rows.rows[0].Author.ID != 2 {
		t.Errorf("rows = %+v", rows.rows)
	}
	open := f.bc.find("open", 4)
	if open.payload["owner_id"] != float64(1) || open.payload["is_group"] != true {
		t.Errorf("dave's open = %v, want the full group summary with owner_id", open.payload)
	}
}

func TestAddMembers_ExistingMembersGetRefreshAndRow(t *testing.T) {
	f := newMembersFixture(t)
	if rr := f.add(t, 0, 4, 5); rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}
	kinds := f.bc.kinds()
	for _, uid := range []int64{1, 2, 3, 4, 5} {
		if !slices.Contains(kinds, fmt.Sprintf("open:%d", uid)) {
			t.Errorf("user %d got no refreshed dm_channel_open: %v", uid, kinds)
		}
	}
	// The opens are all sent before the single rows delivery.
	if kinds[len(kinds)-1] != "rows" || slices.Index(kinds, "rows") != len(kinds)-1 {
		t.Errorf("order = %v, want every open and then one rows delivery", kinds)
	}
	if rows := f.bc.find("rows", 0); len(rows.rows) != 2 {
		t.Errorf("rows = %d, want one per added user", len(rows.rows))
	}
	if f.bc.marks < 1 {
		t.Error("the visibility watermark was not bumped for the unsequenced opens")
	}
}

func TestAddMembers_Errors(t *testing.T) {
	f := newMembersFixture(t)

	if rr := f.add(t, 3, 5); rr.Code != http.StatusNotFound {
		t.Errorf("non-member add = %d, want 404", rr.Code)
	}
	if rr := f.add(t, 0); rr.Code != http.StatusBadRequest {
		t.Errorf("empty add = %d, want 400", rr.Code)
	}
	if rr := f.add(t, 0, 2, 3); rr.Code != http.StatusBadRequest {
		t.Errorf("add of existing members only = %d, want 400", rr.Code)
	}
	if rr := dmDo(t, f.router, http.MethodPost, f.path("/members"), f.tokens[0], "not json"); rr.Code != http.StatusBadRequest {
		t.Errorf("malformed body = %d, want 400", rr.Code)
	}
	if rr := f.add(t, 0, 99); rr.Code != http.StatusNotFound {
		t.Errorf("add of a missing user = %d, want 404", rr.Code)
	}

	oneToOne := decodeCreateDM(t, dmPost(t, f.router, "/api/v1/dms", f.tokens[0], map[string]any{"recipient_id": 2}))
	rr := dmDo(t, f.router, http.MethodPost, fmt.Sprintf("/api/v1/dms/%d/members", oneToOne), f.tokens[0], map[string]any{"user_ids": []int64{4}})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("add to a 1:1 DM = %d, want 400", rr.Code)
	}

	if _, err := f.database.ExecContext(context.Background(), `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (3, 4)`); err != nil {
		t.Fatalf("block: %v", err)
	}
	if rr := f.add(t, 0, 4); rr.Code != http.StatusForbidden {
		t.Errorf("add of a user a member blocked = %d, want 403: %s", rr.Code, rr.Body.String())
	}
	if len(f.bc.kinds()) != 0 || f.groupRowCount(t) != 0 {
		t.Errorf("refused adds sent %v and wrote %d rows", f.bc.kinds(), f.groupRowCount(t))
	}
}

func decodeCreateDM(t *testing.T, rr *httptest.ResponseRecorder) int64 {
	t.Helper()
	var out struct {
		ChannelID int64 `json:"channel_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil || out.ChannelID == 0 {
		t.Fatalf("create DM: %d %s", rr.Code, rr.Body.String())
	}
	return out.ChannelID
}

func TestGroupFull_Returns409GroupDMFull(t *testing.T) {
	f := newMembersFixture(t)
	extra := make([]int64, 0, 7)
	for i := range 7 {
		extra = append(extra, int64(len(f.tokens)+1+i))
		dmCreateToken(t, f.database, fmt.Sprintf("extra%d", i), 4)
	}
	if rr := f.add(t, 0, extra...); rr.Code != http.StatusOK {
		t.Fatalf("filling the group: %d %s", rr.Code, rr.Body.String())
	}
	f.bc.reset()

	rr := f.add(t, 0, 4)
	if rr.Code != http.StatusConflict {
		t.Fatalf("add to a full group = %d, want 409: %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body.Error != "GROUP_DM_FULL" {
		t.Errorf("error code = %q, want GROUP_DM_FULL", body.Error)
	}
	if len(f.bc.kinds()) != 0 {
		t.Errorf("a refused add sent %v", f.bc.kinds())
	}
}

// ─── remove ─────────────────────────────────────────────────────────────────

func TestRemoveMember_RemovedGetsCloseAndNoRow(t *testing.T) {
	f := newMembersFixture(t)
	rr := dmDo(t, f.router, http.MethodDelete, f.path("/members/3"), f.tokens[0], nil)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("remove: %d %s", rr.Code, rr.Body.String())
	}
	kinds := f.bc.kinds()
	if kinds[0] != "close:3" {
		t.Errorf("the removed member's dm_channel_open/close order = %v, want close:3 first", kinds)
	}
	if f.bc.marks < 2 {
		t.Errorf("watermark bumps = %d, want one before the close and one for the survivors' open", f.bc.marks)
	}
	for _, k := range kinds {
		if k == "open:3" {
			t.Error("the removed member was sent a dm_channel_open")
		}
	}
	rows := f.bc.find("rows", 0)
	if rows == nil || slices.Contains(rows.audience, 3) || !slices.Equal(rows.audience, []int64{1, 2}) {
		t.Fatalf("rows = %+v, want delivery to the remaining members only", rows)
	}
	if len(rows.rows) != 1 || rows.rows[0].Kind != "group_remove" || rows.rows[0].TargetUserID != 3 {
		t.Errorf("rows = %+v", rows.rows)
	}
	// Survivors' opens come before the rows.
	if slices.Index(kinds, "open:1") > slices.Index(kinds, "rows") || slices.Index(kinds, "open:2") > slices.Index(kinds, "rows") {
		t.Errorf("order = %v, survivors must get the open before the row", kinds)
	}
}

func TestRemoveMember_EvictsFromGroupCall(t *testing.T) {
	f := newMembersFixture(t)
	if rr := dmDo(t, f.router, http.MethodDelete, f.path("/members/3"), f.tokens[0], nil); rr.Code != http.StatusNoContent {
		t.Fatalf("remove: %d", rr.Code)
	}
	want := evictCall{3, f.group, ws.VoiceLeaveReasonDMRemoved}
	if len(f.bc.evicts) != 1 || f.bc.evicts[0] != want {
		t.Fatalf("evictions = %+v, want exactly %+v", f.bc.evicts, want)
	}
}

func TestRemoveMember_Errors(t *testing.T) {
	f := newMembersFixture(t)
	del := func(tokenIdx int, target int) int {
		return dmDo(t, f.router, http.MethodDelete, f.path(fmt.Sprintf("/members/%d", target)), f.tokens[tokenIdx], nil).Code
	}
	if got := del(1, 3); got != http.StatusForbidden {
		t.Errorf("non-owner remove = %d, want 403", got)
	}
	if got := del(0, 1); got != http.StatusBadRequest {
		t.Errorf("owner removing themselves = %d, want 400 (leave instead)", got)
	}
	if got := del(0, 4); got != http.StatusNotFound {
		t.Errorf("remove of a non-member = %d, want 404", got)
	}
	if got := del(3, 3); got != http.StatusNotFound {
		t.Errorf("remove by a non-member = %d, want 404", got)
	}
	oneToOne := decodeCreateDM(t, dmPost(t, f.router, "/api/v1/dms", f.tokens[0], map[string]any{"recipient_id": 2}))
	rr := dmDo(t, f.router, http.MethodDelete, fmt.Sprintf("/api/v1/dms/%d/members/2", oneToOne), f.tokens[0], nil)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("remove in a 1:1 DM = %d, want 400", rr.Code)
	}
	if len(f.bc.kinds()) != 0 || f.groupRowCount(t) != 0 {
		t.Errorf("refused removes sent %v and wrote %d rows", f.bc.kinds(), f.groupRowCount(t))
	}
}

// ─── owner ──────────────────────────────────────────────────────────────────

func TestTransferOwner_RefreshesMembersWithoutARow(t *testing.T) {
	f := newMembersFixture(t)
	rr := dmDo(t, f.router, http.MethodPut, f.path("/owner"), f.tokens[0], map[string]any{"user_id": 3})
	if rr.Code != http.StatusOK {
		t.Fatalf("transfer: %d %s", rr.Code, rr.Body.String())
	}
	if info := decodeDMInfo(t, rr); info.OwnerID != 3 {
		t.Errorf("response owner_id = %d, want 3", info.OwnerID)
	}
	if kinds := f.bc.kinds(); !slices.Equal(kinds, []string{"open:1", "open:2", "open:3"}) {
		t.Errorf("events = %v, want a refreshed open for each member and no row", kinds)
	}
	if f.bc.find("open", 2).payload["owner_id"] != float64(3) {
		t.Error("bob's refreshed open does not carry the new owner_id")
	}
	if f.groupRowCount(t) != 0 {
		t.Error("a transfer wrote a row")
	}

	put := func(tokenIdx, target int) int {
		return dmDo(t, f.router, http.MethodPut, f.path("/owner"), f.tokens[tokenIdx], map[string]any{"user_id": target}).Code
	}
	if got := put(0, 2); got != http.StatusForbidden {
		t.Errorf("former owner transfer = %d, want 403", got)
	}
	if got := put(2, 3); got != http.StatusBadRequest {
		t.Errorf("transfer to yourself = %d, want 400", got)
	}
	if got := put(2, 4); got != http.StatusNotFound {
		t.Errorf("transfer to a non-member = %d, want 404", got)
	}
}

// ─── leave and rename ───────────────────────────────────────────────────────

func TestLeave_SurvivorsGetNewOwnerAndRow(t *testing.T) {
	f := newMembersFixture(t)
	if rr := dmDelete(t, f.router, f.path(""), f.tokens[0]); rr.Code != http.StatusNoContent {
		t.Fatalf("leave: %d %s", rr.Code, rr.Body.String())
	}
	kinds := f.bc.kinds()
	if kinds[0] != "close:1" {
		t.Errorf("order = %v, want the leaver's close first", kinds)
	}
	open := f.bc.find("open", 2)
	if open == nil || open.payload["owner_id"] != float64(2) {
		t.Fatalf("bob's refreshed open = %+v, want owner_id 2 (lowest remaining)", open)
	}
	if slices.Index(kinds, "open:2") > slices.Index(kinds, "rows") || slices.Index(kinds, "open:3") > slices.Index(kinds, "rows") {
		t.Errorf("order = %v, survivors must get the open before the row", kinds)
	}
	rows := f.bc.find("rows", 0)
	if rows == nil || len(rows.rows) != 1 || rows.rows[0].Kind != "group_leave" || rows.rows[0].Author.ID != 1 {
		t.Fatalf("rows = %+v, want one group_leave authored by the leaver", rows)
	}
	if !slices.Equal(rows.audience, []int64{2, 3}) {
		t.Errorf("audience = %v, want the survivors", rows.audience)
	}
	if len(f.bc.evicts) != 1 || f.bc.evicts[0].reason != ws.VoiceLeaveReasonDMLeave {
		t.Errorf("evictions = %+v", f.bc.evicts)
	}
}

func TestLeave_LastMemberWritesNoRow(t *testing.T) {
	f := newMembersFixture(t)
	for i := range 3 {
		if rr := dmDelete(t, f.router, f.path(""), f.tokens[i]); rr.Code != http.StatusNoContent {
			t.Fatalf("leave %d: %d", i, rr.Code)
		}
	}
	rows := 0
	for _, k := range f.bc.kinds() {
		if k == "rows" {
			rows++
		}
	}
	if rows != 2 {
		t.Errorf("row deliveries = %d, want 2 (the last leaver writes none)", rows)
	}
}

func TestRename_WritesRowAndUnchangedSendsNothing(t *testing.T) {
	f := newMembersFixture(t)
	rr := dmPatch(t, f.router, f.path(""), f.tokens[1], map[string]any{"name": "Raid night"})
	if rr.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", rr.Code, rr.Body.String())
	}
	kinds := f.bc.kinds()
	if !slices.Equal(kinds, []string{"open:1", "open:2", "open:3", "rows"}) {
		t.Errorf("events = %v, want the three refreshed opens and then the row", kinds)
	}
	rows := f.bc.find("rows", 0)
	if len(rows.rows) != 1 || rows.rows[0].Kind != "group_rename" || rows.rows[0].Name == nil || *rows.rows[0].Name != "Raid night" {
		t.Errorf("rows = %+v", rows.rows)
	}

	f.bc.reset()
	if rr := dmPatch(t, f.router, f.path(""), f.tokens[0], map[string]any{"name": "Raid night"}); rr.Code != http.StatusOK {
		t.Fatalf("rename to the same name: %d", rr.Code)
	}
	if len(f.bc.kinds()) != 0 {
		t.Errorf("an unchanged name sent %v", f.bc.kinds())
	}
}

// ─── rate limit ─────────────────────────────────────────────────────────────

func TestGroupRoutes_RateLimitedPerUser(t *testing.T) {
	database := newDMTestDB(t)
	bc := &recordingBroadcaster{}
	limiter := auth.NewRateLimiter()
	router := buildLimitedDMRouter(database, bc, limiter)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
		dmCreateToken(t, database, "carol", 4),
	}
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{"recipient_ids": []int64{2, 3}}))
	path := fmt.Sprintf("/api/v1/dms/%d", group.ChannelID)

	// Twenty renames a minute pass (alternating names so each one is a change);
	// the twenty-first is refused.
	for i := range 20 {
		name := fmt.Sprintf("name %d", i)
		if rr := dmPatch(t, router, path, tokens[0], map[string]any{"name": name}); rr.Code != http.StatusOK {
			t.Fatalf("rename %d: %d %s", i, rr.Code, rr.Body.String())
		}
	}
	if rr := dmPatch(t, router, path, tokens[0], map[string]any{"name": "one too many"}); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("21st change = %d, want 429", rr.Code)
	}
	// The budget is shared by add, remove and owner for that user ...
	if rr := dmDo(t, router, http.MethodPut, path+"/owner", tokens[0], map[string]any{"user_id": 2}); rr.Code != http.StatusTooManyRequests {
		t.Errorf("owner route after the budget = %d, want 429", rr.Code)
	}
	if rr := dmDo(t, router, http.MethodDelete, path+"/members/3", tokens[0], nil); rr.Code != http.StatusTooManyRequests {
		t.Errorf("remove route after the budget = %d, want 429", rr.Code)
	}
	if rr := dmDo(t, router, http.MethodPost, path+"/members", tokens[0], map[string]any{"user_ids": []int64{2}}); rr.Code != http.StatusTooManyRequests {
		t.Errorf("add route after the budget = %d, want 429", rr.Code)
	}
	// ... but it is per user: bob is untouched.
	if rr := dmPatch(t, router, path, tokens[1], map[string]any{"name": "bob's turn"}); rr.Code != http.StatusOK {
		t.Errorf("another user's rename = %d, want 200", rr.Code)
	}
	// And leaving is not limited.
	if rr := dmDelete(t, router, path, tokens[0]); rr.Code != http.StatusNoContent {
		t.Errorf("leave after the budget = %d, want 204", rr.Code)
	}
}

// ─── fan-out survives the request ───────────────────────────────────────────

// cancelAfterAddStore commits the add and then cancels the request, standing in
// for a client that hangs up right after the commit.
type cancelAfterAddStore struct {
	*db.DB
	cancel func()
}

func (s *cancelAfterAddStore) AddGroupDMMembers(ctx context.Context, channelID, actorID int64, ids []int64, contentFor func(int64) string) (*db.GroupChange, error) {
	change, err := s.DB.AddGroupDMMembers(ctx, channelID, actorID, ids, contentFor)
	s.cancel()
	return change, err
}

func TestFanOut_SurvivesRequestCancelAfterCommit(t *testing.T) {
	f := newMembersFixture(t)
	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	svc := service.New(f.database, auth.NewRateLimiter())
	svc.DMs = service.NewDMService(&cancelAfterAddStore{DB: f.database, cancel: cancel}, svc.Permissions)
	r := chi.NewRouter()
	api.MountDMRoutes(r, f.database, svc, f.bc, nil)

	raw, _ := json.Marshal(map[string]any{"user_ids": []int64{4}})
	req := httptest.NewRequest(http.MethodPost, f.path("/members"), bytes.NewReader(raw)).WithContext(reqCtx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+f.tokens[0])
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if reqCtx.Err() == nil {
		t.Fatal("test bug: the request context was never cancelled")
	}
	if rr.Code >= 500 {
		t.Errorf("status = %d, a committed add must not answer a server error", rr.Code)
	}
	var members int
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?`, f.group).Scan(&members); err != nil || members != 4 {
		t.Fatalf("members = %d (%v), want the add committed", members, err)
	}
	kinds := f.bc.kinds()
	for _, want := range []string{"open:1", "open:2", "open:3", "open:4", "rows"} {
		if !slices.Contains(kinds, want) {
			t.Errorf("fan-out after the cancel is missing %s: %v", want, kinds)
		}
	}
	rows := f.bc.find("rows", 0)
	if rows == nil || len(rows.rows) != 1 {
		t.Fatalf("rows = %+v, want one group_add", rows)
	}
	if got := rows.rows[0].Author; got == nil || got.Username == "" {
		t.Errorf("row author = %+v, want the resolved author (post-commit reads must outlive the request)", got)
	}
}
