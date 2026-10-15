package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// An About Me can hold any text, including the exact bytes encodeRoster
// searches for to find its splice points. A string value escapes its quotes,
// so the splice must still land on the real status field.
func TestEncodeRoster_SplicesWithAbout(t *testing.T) {
	about := `"status":"" and "custom_status":null} tricks`
	custom := "busy"
	members := []db.MemberSummary{{
		ID: 1, Username: "alice", Status: db.StatusOnline, Role: "member",
		About: &about, CreatedAt: "2026-10-15T13:04:05Z", CustomStatus: &custom,
	}}
	roster, err := encodeRoster(members)
	if err != nil {
		t.Fatalf("encodeRoster: %v", err)
	}
	var b strings.Builder
	b.Write(roster.enc[0].head)
	b.WriteString(`"online"`)
	b.Write(roster.enc[0].mid)
	b.Write(roster.enc[0].custom)
	b.WriteString("}")
	var got map[string]any
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil {
		t.Fatalf("spliced member is not JSON: %v\n%s", err, b.String())
	}
	if got["about"] != about || got["status"] != "online" || got["custom_status"] != "busy" ||
		got["created_at"] != "2026-10-15T13:04:05Z" {
		t.Errorf("spliced member = %v", got)
	}
}

// chat_message.user shares memberUserPayload with member_join.user; only the
// latter may carry about and created_at.
func TestChatMessage_UserHasNoAbout(t *testing.T) {
	raw := buildChatMessage(chatMessageArgs{UserID: 1, Username: "alice", RoleName: "member"})
	var env struct {
		Payload struct {
			User map[string]any `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"about", "created_at"} {
		if _, ok := env.Payload.User[k]; ok {
			t.Errorf("chat_message.user carries %q", k)
		}
	}
}

func TestBuildMemberJoin_CarriesAboutAndCreatedAt(t *testing.T) {
	about := "hi"
	raw := buildMemberJoin(&db.User{ID: 2, Username: "bob", About: &about, CreatedAt: "2026-10-15 13:04:05", Status: db.StatusOnline}, "member")
	var env struct {
		Payload struct {
			User map[string]any `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.User["about"] != "hi" || env.Payload.User["created_at"] != "2026-10-15T13:04:05Z" {
		t.Errorf("member_join.user = %v", env.Payload.User)
	}
}
