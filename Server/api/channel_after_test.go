package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── GET /api/v1/channels/{id}/messages?after= ──────────────────────────────
//
// `after` is the downward continuation of a detached around-window: the page
// of messages newer than a cursor, oldest-first, behind the same read gate as
// `before`.

type afterResponse struct {
	Messages []struct {
		ID int64 `json:"id"`
	} `json:"messages"`
	HasMore bool `json:"has_more"`
}

func afterPath(channelID int64, query string) string {
	return fmt.Sprintf("/api/v1/channels/%d/messages?%s", channelID, query)
}

func decodeAfter(t *testing.T, rr *httptest.ResponseRecorder) (ids []int64, hasMore bool) {
	t.Helper()
	var resp afterResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v (body: %s)", err, rr.Body.String())
	}
	for _, m := range resp.Messages {
		ids = append(ids, m.ID)
	}
	return ids, resp.HasMore
}

func TestChannelMessages_AfterReturnsAscendingNewerPage(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "afterasc", 1)
	chID, ids := seedAroundChannel(t, database, "afterasc", 8)

	rr := chGet(t, router, afterPath(chID, fmt.Sprintf("after=%d&limit=3", ids[2])), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	got, hasMore := decodeAfter(t, rr)
	if want := ids[3:6]; !slices.Equal(got, want) {
		t.Errorf("ids = %v, want %v (ascending, strictly after the cursor)", got, want)
	}
	if !hasMore {
		t.Error("has_more = false, want true: two newer messages remain")
	}

	// The final page reaches the newest message and reports no more.
	rr = chGet(t, router, afterPath(chID, fmt.Sprintf("after=%d&limit=3", ids[5])), token)
	got, hasMore = decodeAfter(t, rr)
	if want := ids[6:]; !slices.Equal(got, want) || hasMore {
		t.Errorf("last page = %v (has_more %v), want %v and no more", got, hasMore, want)
	}
}

func TestChannelMessages_AfterNewestIsEmpty(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "afternewest", 1)
	chID, ids := seedAroundChannel(t, database, "afternewest", 3)

	rr := chGet(t, router, afterPath(chID, fmt.Sprintf("after=%d", ids[2])), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	got, hasMore := decodeAfter(t, rr)
	if len(got) != 0 || hasMore {
		t.Errorf("page = %v (has_more %v), want empty", got, hasMore)
	}
	if body := rr.Body.String(); !json.Valid([]byte(body)) {
		t.Errorf("body not JSON: %s", body)
	}
}

func TestChannelMessages_AfterRejectsBadQuery(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "afterbad", 1)
	chID, ids := seedAroundChannel(t, database, "afterbad", 3)

	for _, q := range []string{
		"after=abc",
		"after=0",
		"after=-4",
		fmt.Sprintf("after=%d&before=%d", ids[0], ids[2]), // opposite directions
		fmt.Sprintf("after=%d&before=0", ids[0]),
		fmt.Sprintf("after=%d&limit=abc", ids[0]),
	} {
		rr := chGet(t, router, afterPath(chID, q), token)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("query %q: status = %d, want 400; body: %s", q, rr.Code, rr.Body.String())
		}
	}
}

func TestChannelMessages_AfterDeniedByPermission(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	ownerToken := chTestCreateToken(t, database, "afterowner", 1)
	deniedToken := chTestCreateToken(t, database, "afterdenied", 4)
	chID, ids := seedAroundChannel(t, database, "afterowner", 3)
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	after := chGet(t, router, afterPath(chID, fmt.Sprintf("after=%d", ids[0])), deniedToken)
	before := chGet(t, router, afterPath(chID, fmt.Sprintf("before=%d", ids[2])), deniedToken)
	if after.Code != http.StatusForbidden || before.Code != after.Code {
		t.Errorf("denied member: after = %d, before = %d; want 403 for both", after.Code, before.Code)
	}
	if after.Body.String() != before.Body.String() {
		t.Errorf("denied bodies differ: after %s vs before %s", after.Body.String(), before.Body.String())
	}
	if rr := chGet(t, router, afterPath(chID, fmt.Sprintf("after=%d", ids[0])), ownerToken); rr.Code != http.StatusOK {
		t.Errorf("owner status = %d, want 200", rr.Code)
	}
}

func TestChannelMessages_AfterUnknownChannelIsNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "afternochan", 1)
	if rr := chGet(t, router, afterPath(9999, "after=1"), token); rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}
