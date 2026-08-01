package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// ─── GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users ──
//
// The who-reacted list is a separate endpoint rather than inline user_ids on
// every reaction summary, so the contract worth pinning is: the same read gate
// as history, and a path emoji that survives percent-encoding.

type reactionUsersResponse struct {
	Users []struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
		Avatar   string `json:"avatar"`
	} `json:"users"`
}

func reactionUsersPath(channelID, messageID int64, emoji string) string {
	return fmt.Sprintf("/api/v1/channels/%d/messages/%d/reactions/%s/users",
		channelID, messageID, url.PathEscape(emoji))
}

// seedReactedMessage creates a channel with one message and has each of the
// named users react to it with emoji. Returns the channel and message ids.
func seedReactedMessage(t *testing.T, database *db.DB, chName string, author string, emoji string, reactors ...string) (int64, int64) {
	t.Helper()
	user, err := database.GetUserByUsername(context.Background(), author)
	if err != nil {
		t.Fatalf("GetUserByUsername(%q): %v", author, err)
	}
	chID, err := database.CreateChannel(context.Background(), chName, "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgID, err := database.CreateMessage(context.Background(), chID, user.ID, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	for _, name := range reactors {
		u, uErr := database.GetUserByUsername(context.Background(), name)
		if uErr != nil {
			t.Fatalf("GetUserByUsername(%q): %v", name, uErr)
		}
		if rErr := database.AddReaction(context.Background(), msgID, u.ID, emoji); rErr != nil {
			t.Fatalf("AddReaction(%q): %v", name, rErr)
		}
	}
	return chID, msgID
}

func decodeReactionUsers(t *testing.T, rr *httptest.ResponseRecorder) reactionUsersResponse {
	t.Helper()
	var resp reactionUsersResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v (body: %s)", err, rr.Body.String())
	}
	return resp
}

func TestReactionUsers_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, reactionUsersPath(1, 1, "👍"), "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

// The emoji reaches the handler percent-encoded; chi routes on RawPath, so the
// handler must unescape it or every non-ASCII emoji looks like a different one.
func TestReactionUsers_PercentEncodedEmojiResolves(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ru-author", 4)
	_ = chTestCreateToken(t, database, "ru-bob", 4)
	chID, msgID := seedReactedMessage(t, database, "ru-chan", "ru-author", "👍", "ru-author", "ru-bob")

	path := reactionUsersPath(chID, msgID, "👍")
	if path == fmt.Sprintf("/api/v1/channels/%d/messages/%d/reactions/👍/users", chID, msgID) {
		t.Fatal("test precondition: the emoji should be percent-encoded in the path")
	}

	rr := chGet(t, router, path, token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeReactionUsers(t, rr)
	if len(resp.Users) != 2 {
		t.Fatalf("len(users) = %d, want 2 (%+v)", len(resp.Users), resp.Users)
	}
	if resp.Users[0].Username != "ru-author" || resp.Users[1].Username != "ru-bob" {
		t.Errorf("usernames = [%s %s], want [ru-author ru-bob]",
			resp.Users[0].Username, resp.Users[1].Username)
	}
}

func TestReactionUsers_EmojiWithNoReactorsIsEmptyList(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ru-empty", 4)
	chID, msgID := seedReactedMessage(t, database, "ru-emptychan", "ru-empty", "👍", "ru-empty")

	rr := chGet(t, router, reactionUsersPath(chID, msgID, "🎉"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeReactionUsers(t, rr)
	if len(resp.Users) != 0 {
		t.Errorf("len(users) = %d, want 0", len(resp.Users))
	}
	// null would not be iterable client-side.
	if !json.Valid(rr.Body.Bytes()) || rr.Body.String() == "" {
		t.Fatalf("invalid body: %s", rr.Body.String())
	}
}

func TestReactionUsers_DeniedChannelIsForbidden(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ru-denied", 4)
	chID, msgID := seedReactedMessage(t, database, "ru-deniedchan", "ru-denied", "👍", "ru-denied")
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	rr := chGet(t, router, reactionUsersPath(chID, msgID, "👍"), token)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

func TestReactionUsers_MessageFromAnotherChannelIsNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ru-cross", 4)
	_, msgID := seedReactedMessage(t, database, "ru-crossA", "ru-cross", "👍", "ru-cross")
	otherID, _ := database.CreateChannel(context.Background(), "ru-crossB", "text", "", "", 1)

	rr := chGet(t, router, reactionUsersPath(otherID, msgID, "👍"), token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestReactionUsers_InvalidIDs(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "ru-badid", 4)

	for _, path := range []string{
		"/api/v1/channels/abc/messages/1/reactions/%F0%9F%91%8D/users",
		"/api/v1/channels/1/messages/0/reactions/%F0%9F%91%8D/users",
	} {
		rr := chGet(t, router, path, token)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", path, rr.Code)
		}
	}
}
